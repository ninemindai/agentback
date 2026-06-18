// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Security properties of the file recipe — the two FIXMEs dapp5 left open:
//   1. No path traversal: the download id is a server lookup key; the actual
//      storage key is a server-generated UUID, never client-derived.
//   2. Ownership enforced: a caller can only download files they uploaded.

import {afterEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import supertest from 'supertest';
import {z} from 'zod';
import createError from 'http-errors';
import {inject} from '@agentback/core';
import {api, get, post, fileField} from '@agentback/openapi';
import {
  FILE_STORE,
  InMemoryFileStore,
  type FileStore,
} from '@agentback/files';
import {RestApplication} from '../../rest.application.js';
import {fileDownload} from '../../file-response.js';

interface Meta {
  key: string;
  owner: string;
  filename: string;
}
class MetaStore {
  readonly map = new Map<string, Meta>();
}
const META_STORE = 'vault.meta';

const Upload = z.object({file: fileField()});
const Caller = z.object({'x-user-id': z.string()});
const IdParam = z.object({id: z.string()});

@api({basePath: '/vault'})
class VaultController {
  constructor(
    @inject(FILE_STORE) private store: FileStore,
    @inject(META_STORE) private meta: MetaStore,
  ) {}

  @post('/', {body: Upload, headers: Caller})
  async upload(input: {
    body: z.infer<typeof Upload>;
    headers: z.infer<typeof Caller>;
  }) {
    const f = input.body.file;
    const id = randomUUID();
    // Note: we persist f.key (a server-generated UUID from the parser), never
    // the client filename — that's what defeats key traversal.
    this.meta.map.set(id, {
      key: f.key!,
      owner: input.headers['x-user-id'],
      filename: f.filename,
    });
    return {id, storedKey: f.key};
  }

  @get('/{id}', {path: IdParam, headers: Caller})
  async download(input: {
    path: z.infer<typeof IdParam>;
    headers: z.infer<typeof Caller>;
  }) {
    const m = this.meta.map.get(input.path.id);
    if (!m) throw createError(404, 'No such file.');
    if (m.owner !== input.headers['x-user-id']) {
      throw createError(403, 'You do not own this file.');
    }
    const file = await this.store.get(m.key);
    return fileDownload(file, {disposition: 'inline'});
  }
}

async function boot() {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  app.bind(FILE_STORE).to(new InMemoryFileStore());
  app.bind(META_STORE).to(new MetaStore());
  app.restController(VaultController);
  await app.start();
  return {app, client: supertest((await app.restServer).url), stop: () => app.stop()};
}

function upload(client: ReturnType<typeof supertest>, user: string) {
  return client
    .post('/vault/')
    .set('x-user-id', user)
    .attach('file', Buffer.from(`owned by ${user}`), {
      filename: 'secret.txt',
      contentType: 'text/plain',
    });
}

describe('file recipe security', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('the owner can download their own file', async () => {
    const {client, stop: s} = await boot();
    stop = s;
    const up = await upload(client, 'alice').expect(200);
    const down = await client
      .get(`/vault/${up.body.id}`)
      .set('x-user-id', 'alice')
      .expect(200);
    expect(down.text).toBe('owned by alice');
  });

  it('a different user gets 403 (ownership enforced)', async () => {
    const {client, stop: s} = await boot();
    stop = s;
    const up = await upload(client, 'alice').expect(200);
    await client
      .get(`/vault/${up.body.id}`)
      .set('x-user-id', 'mallory')
      .expect(403);
  });

  it('the storage key is a server UUID, not the client filename', async () => {
    const {client, stop: s} = await boot();
    stop = s;
    const up = await upload(client, 'alice').expect(200);
    // key is a UUID, unrelated to "secret.txt"
    expect(up.body.storedKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(up.body.storedKey).not.toContain('secret');
  });

  it('a traversal-shaped id resolves to nothing → 404 (no key injection)', async () => {
    const {client, stop: s} = await boot();
    stop = s;
    await upload(client, 'alice').expect(200);
    // A crafted id is just a Map miss — it never reaches the store as a key.
    await client
      .get('/vault/..%2f..%2fetc%2fpasswd')
      .set('x-user-id', 'alice')
      .expect(404);
  });
});
