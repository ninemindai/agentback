// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Regression: @api({basePath: '/'}) must mount at /ping, not //ping. The
// basePath + path join collapses duplicate slashes on both hosts.

import {afterEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';

@api({basePath: '/'})
class RootController {
  @get('/ping')
  async ping() {
    return {ok: true};
  }
}

async function boot() {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  app.restController(RootController);
  await app.start();
  return app;
}

describe("root basePath '/'", () => {
  let app: RestApplication | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it('mounts at /ping on the Express host (not //ping)', async () => {
    app = await boot();
    const client = supertest((await app.restServer).url);
    await client.get('/ping').expect(200, {ok: true});
  });

  it('mounts at /ping on the edge/Web host', async () => {
    app = await boot();
    const host = (await app.getServer<RestServer>('RestServer')).fetchHandler();
    const res = await host.fetch(new Request('http://local/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
  });

  it('emits /ping (not //ping) in the OpenAPI doc', async () => {
    app = await boot();
    const client = supertest((await app.restServer).url);
    const spec = await client.get('/openapi.json').expect(200);
    const keys = Object.keys(spec.body.paths);
    expect(keys).toContain('/ping');
    expect(keys).not.toContain('//ping');
  });
});
