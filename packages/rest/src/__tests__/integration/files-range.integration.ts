// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// End-to-end HTTP Range support: serveFile() + the REST send path emit
// 200/206/416 with the right Content-Range / Accept-Ranges headers.

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, get} from '@agentback/openapi';
import {FILE_STORE, InMemoryFileStore, type FileStore} from '@agentback/files';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';
import {serveFile} from '../../file-response.js';

const IdParam = z.object({id: z.string()});
const RangeHeader = z.object({range: z.string().optional()});
const BODY = '0123456789'; // 10 bytes, key = "media"

@api({basePath: '/media'})
class MediaController {
  constructor(@inject(FILE_STORE) private store: FileStore) {}

  @get('/{id}', {path: IdParam, headers: RangeHeader})
  async stream(input: {
    path: z.infer<typeof IdParam>;
    headers: z.infer<typeof RangeHeader>;
  }) {
    return serveFile(this.store, input.path.id, {
      range: input.headers.range,
      disposition: 'inline',
    });
  }
}

async function boot() {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  const store = new InMemoryFileStore();
  await store.put('media', Buffer.from(BODY), {contentType: 'text/plain'});
  app.bind(FILE_STORE).to(store);
  app.restController(MediaController);
  await app.start();
  return {app, client: supertest((await app.restServer).url)};
}

describe('HTTP Range → 206', () => {
  let app: RestApplication | undefined;
  let client: ReturnType<typeof supertest>;
  beforeEach(async () => {
    const booted = await boot();
    app = booted.app;
    client = booted.client;
  });
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it('serves the whole object with Accept-Ranges when no Range is sent', async () => {
    const res = await client.get('/media/media').expect(200);
    expect(res.text).toBe(BODY);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe('10');
  });

  it('serves a 206 slice with Content-Range for a closed range', async () => {
    const res = await client
      .get('/media/media')
      .set('Range', 'bytes=2-5')
      .expect(206);
    expect(res.text).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('serves an open-ended range to EOF', async () => {
    const res = await client
      .get('/media/media')
      .set('Range', 'bytes=7-')
      .expect(206);
    expect(res.text).toBe('789');
    expect(res.headers['content-range']).toBe('bytes 7-9/10');
  });

  it('serves a suffix range (final N bytes)', async () => {
    const res = await client
      .get('/media/media')
      .set('Range', 'bytes=-3')
      .expect(206);
    expect(res.text).toBe('789');
    expect(res.headers['content-range']).toBe('bytes 7-9/10');
  });

  it('replies 416 with Content-Range for an unsatisfiable range', async () => {
    const res = await client
      .get('/media/media')
      .set('Range', 'bytes=50-')
      .expect(416);
    expect(res.headers['content-range']).toBe('bytes */10');
  });

  it('ignores a malformed Range and serves the whole object', async () => {
    const res = await client
      .get('/media/media')
      .set('Range', 'bytes=oops')
      .expect(200);
    expect(res.text).toBe(BODY);
  });
});

describe('HTTP Range → 206 (edge / Web dispatch)', () => {
  let app: RestApplication | undefined;
  let host: ReturnType<RestServer['fetchHandler']>;
  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    const store = new InMemoryFileStore();
    await store.put('media', Buffer.from(BODY), {contentType: 'text/plain'});
    app.bind(FILE_STORE).to(store);
    app.restController(MediaController);
    await app.start();
    host = (await app.getServer<RestServer>('RestServer')).fetchHandler();
  });
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it('emits a 206 slice with Content-Range on the Web Response', async () => {
    const res = await host.fetch(
      new Request('http://local/media/media', {headers: {Range: 'bytes=2-5'}}),
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
  });

  it('emits 416 for an unsatisfiable range', async () => {
    const res = await host.fetch(
      new Request('http://local/media/media', {headers: {Range: 'bytes=99-'}}),
    );
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */10');
  });
});
