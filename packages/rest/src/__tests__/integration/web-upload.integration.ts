// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, post, fileField} from '@agentback/openapi';
import {FILE_STORE, InMemoryFileStore, type FileStore} from '@agentback/files';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';

// Multipart UPLOADS on the runtime-neutral Web dispatch path: a `fileField()`
// route driven through `fetchHandler()` (and through Express in web-dispatch
// mode) must stream each file to the bound FileStore under a server UUID and
// deliver an UploadedFile handle — at parity with the Express+multer path.

const Upload = z.object({
  file: fileField({maxSize: 1000, mimeTypes: ['text/plain']}),
  caption: z.string().optional(),
});

@api({basePath: '/files'})
class FileController {
  constructor(
    @inject(FILE_STORE, {optional: true}) private store?: FileStore,
  ) {}

  @post('/', {body: Upload})
  async upload(input: {body: z.infer<typeof Upload>}) {
    const f = input.body.file;
    return {
      key: f.key ?? null,
      size: f.size,
      mime: f.mimeType,
      name: f.filename,
      fieldname: f.fieldname ?? null,
      caption: input.body.caption ?? null,
      buffered: !!f.buffer,
    };
  }
}

async function boot(opts: {withStore: boolean}) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  const store = opts.withStore ? new InMemoryFileStore() : undefined;
  if (store) app.bind(FILE_STORE).to(store);
  app.restController(FileController);
  await app.start();
  const server = await app.getServer<RestServer>('RestServer');
  return {
    app,
    store,
    server,
    host: server.fetchHandler(),
    stop: () => app.stop(),
  };
}

// Build a multipart Request via the Web-standard FormData + Blob.
function multipartRequest(parts: {
  file?: {name: string; type: string; bytes: Uint8Array} | null;
  caption?: string;
}): Request {
  const form = new FormData();
  if (parts.caption != null) form.set('caption', parts.caption);
  if (parts.file) {
    form.set(
      'file',
      new Blob([parts.file.bytes], {type: parts.file.type}),
      parts.file.name,
    );
  }
  return new Request('http://x/files/', {method: 'POST', body: form});
}

describe('multipart upload on the Web dispatch path', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('streams a file to the FileStore under a UUID and yields the handle', async () => {
    const {host, store, stop: s} = await boot({withStore: true});
    stop = s;

    const r = await host.fetch(
      multipartRequest({
        caption: 'a greeting',
        file: {
          name: 'greeting.txt',
          type: 'text/plain',
          bytes: new TextEncoder().encode('hello world'),
        },
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {key: string; size: number};
    expect(body).toMatchObject({
      size: 11,
      mime: 'text/plain',
      name: 'greeting.txt',
      fieldname: 'file',
      caption: 'a greeting',
      buffered: false, // streamed to the store
    });
    // Server-generated UUID key.
    expect(body.key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The bytes actually landed in the store under that key.
    expect(store!.count).toBe(1);
    const got = await store!.get(body.key);
    const chunks: Buffer[] = [];
    for await (const c of got.stream) chunks.push(Buffer.from(c));
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
  });

  it('buffers in memory when no FileStore is bound', async () => {
    const {host, stop: s} = await boot({withStore: false});
    stop = s;
    const r = await host.fetch(
      multipartRequest({
        file: {
          name: 'note.txt',
          type: 'text/plain',
          bytes: new TextEncoder().encode('hi'),
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({size: 2, buffered: true, key: null});
  });

  it('rejects an oversize file mid-stream with 413 and stores no orphan', async () => {
    const {host, store, stop: s} = await boot({withStore: true});
    stop = s;
    const r = await host.fetch(
      multipartRequest({
        file: {
          name: 'big.txt',
          type: 'text/plain',
          bytes: new Uint8Array(2000).fill(0x61),
        },
      }),
    );
    expect(r.status).toBe(413);
    expect(((await r.json()) as {error: {code: string}}).error.code).toBe(
      'payload_too_large',
    );
    // The partial was deleted on abort — no orphan left behind.
    expect(store!.count).toBe(0);
  });

  it('rejects a disallowed mime type pre-stream with 415 (no orphan)', async () => {
    const {host, store, stop: s} = await boot({withStore: true});
    stop = s;
    const r = await host.fetch(
      multipartRequest({
        file: {
          name: 'data.json',
          type: 'application/json', // not in the text/plain allowlist
          bytes: new TextEncoder().encode('{}'),
        },
      }),
    );
    expect(r.status).toBe(415);
    expect(((await r.json()) as {error: {code: string}}).error.code).toBe(
      'unsupported_media_type',
    );
    expect(store!.count).toBe(0);
  });

  it('rejects a missing required file with 400 (Zod body validation)', async () => {
    const {host, stop: s} = await boot({withStore: true});
    stop = s;
    const r = await host.fetch(multipartRequest({caption: 'no file here'}));
    // A missing required file fails the Zod body schema → the standard
    // invalid-request-body status (422), same as the Express path.
    expect(r.status).toBe(422);
  });
});

// ----- Express <-> Web parity (web-dispatch mode) -----
//
// The same upload over Express (web-dispatch mode, supertest multipart) and over
// `fetchHandler()` must produce equivalent stored bytes, handler-visible bundle
// shape, and error envelopes. We force web-dispatch via the env flag the
// RestServer reads at construction.
describe('Express<->Web upload parity (web-dispatch mode)', () => {
  let stop: (() => Promise<void>) | undefined;
  const prev = process.env.AGENTBACK_REST_DISPATCH;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
    if (prev === undefined) delete process.env.AGENTBACK_REST_DISPATCH;
    else process.env.AGENTBACK_REST_DISPATCH = prev;
  });

  it('multipart upload over Express (web-mode) matches the fetch surface', async () => {
    process.env.AGENTBACK_REST_DISPATCH = 'web';
    const {server, store, host, stop: s} = await boot({withStore: true});
    stop = s;
    const http = supertest(server.url);

    // Express surface (multer NOT mounted in web-mode — RestHandler parses it).
    const r1 = await http
      .post('/files/')
      .field('caption', 'hi')
      .attach('file', Buffer.from('parity bytes'), {
        filename: 'p.txt',
        contentType: 'text/plain',
      })
      .expect(200);
    expect(r1.body).toMatchObject({
      size: 12,
      mime: 'text/plain',
      name: 'p.txt',
      caption: 'hi',
      buffered: false,
    });
    expect(store!.count).toBe(1);

    // Fetch surface, same payload.
    const r2 = await host.fetch(
      multipartRequest({
        caption: 'hi',
        file: {
          name: 'p.txt',
          type: 'text/plain',
          bytes: new TextEncoder().encode('parity bytes'),
        },
      }),
    );
    const b2 = (await r2.json()) as Record<string, unknown>;
    expect(r2.status).toBe(200);
    // Same bundle shape (keys differ only by the random UUID).
    expect({...b2, key: '<uuid>'}).toEqual({...r1.body, key: '<uuid>'});
  });

  it('oversize 413 envelope matches across Express (web-mode) and fetch', async () => {
    process.env.AGENTBACK_REST_DISPATCH = 'web';
    const {server, host, stop: s} = await boot({withStore: true});
    stop = s;
    const http = supertest(server.url);

    const r1 = await http
      .post('/files/')
      .attach('file', Buffer.alloc(2000, 0x61), {
        filename: 'big.txt',
        contentType: 'text/plain',
      });
    const r2 = await host.fetch(
      multipartRequest({
        file: {
          name: 'big.txt',
          type: 'text/plain',
          bytes: new Uint8Array(2000).fill(0x61),
        },
      }),
    );
    expect(r1.status).toBe(413);
    expect(r2.status).toBe(413);
    expect(r1.body).toEqual(await r2.json());
  });
});
