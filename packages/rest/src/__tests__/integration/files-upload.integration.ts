// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, get, post, fileField} from '@agentback/openapi';
import {FILE_STORE, InMemoryFileStore, type FileStore} from '@agentback/files';
import {RestApplication} from '../../rest.application.js';
import {fileDownload} from '../../file-response.js';

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
      caption: input.body.caption ?? null,
      buffered: !!f.buffer,
    };
  }

  @get('/{key}', {path: z.object({key: z.string()})})
  async download(input: {path: {key: string}}) {
    const f = await this.store!.get(input.path.key);
    return fileDownload(f);
  }
}

async function boot(opts: {withStore: boolean}) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  const store = opts.withStore ? new InMemoryFileStore() : undefined;
  if (store) app.bind(FILE_STORE).to(store);
  app.restController(FileController);
  await app.start();
  return {
    app,
    store,
    client: supertest((await app.restServer).url),
    stop: () => app.stop(),
  };
}

describe('multipart upload + file download', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('uploads to the FileStore and downloads it back round-trip', async () => {
    const {client, stop: s} = await boot({withStore: true});
    stop = s;

    const up = await client
      .post('/files/')
      .field('caption', 'a greeting')
      .attach('file', Buffer.from('hello world'), {
        filename: 'greeting.txt',
        contentType: 'text/plain',
      })
      .expect(200);
    expect(up.body).toMatchObject({
      size: 11,
      mime: 'text/plain',
      name: 'greeting.txt',
      caption: 'a greeting',
      buffered: false, // streamed to the store, not buffered
    });
    expect(up.body.key).toBeTruthy();

    const down = await client.get(`/files/${up.body.key}`).expect(200);
    expect(down.headers['content-type']).toMatch(/text\/plain/);
    expect(down.headers['content-disposition']).toBe(
      'attachment; filename="greeting.txt"',
    );
    expect(down.text).toBe('hello world');
  });

  it('rejects an oversize file with 413 (multer limit, pre-validation)', async () => {
    const {client, stop: s} = await boot({withStore: true});
    stop = s;
    await client
      .post('/files/')
      .attach('file', Buffer.alloc(2000, 0x61), {
        filename: 'big.txt',
        contentType: 'text/plain',
      })
      .expect(413);
  });

  it('rejects a disallowed mime type pre-stream (415, no orphan stored)', async () => {
    const {client, store, stop: s} = await boot({withStore: true});
    stop = s;
    await client
      .post('/files/')
      .attach('file', Buffer.from('{}'), {
        filename: 'data.json',
        contentType: 'application/json', // not in the text/plain allowlist
      })
      .expect(415);
    // The fileFilter rejected before _handleFile ran → nothing was stored.
    expect(store!.count).toBe(0);
  });

  it('buffers in memory when no FileStore is bound', async () => {
    const {client, stop: s} = await boot({withStore: false});
    stop = s;
    const up = await client
      .post('/files/')
      .attach('file', Buffer.from('hi'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      })
      .expect(200);
    expect(up.body).toMatchObject({size: 2, buffered: true, key: null});
  });
});
