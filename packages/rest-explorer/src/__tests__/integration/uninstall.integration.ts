// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Revertible-install conformance (docs/proposals/revertible-installs.md),
 * wave 1: installExplorer returns an `Installed` whose `uninstall()` retracts
 * the full footprint on BOTH hosts — the Express layers 404 again (gate-flag
 * pattern; Express cannot unmount) and the fetch handlers are removed.
 */

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication, type RestServer} from '@agentback/rest';
import {installExplorer} from '../../index.js';

@api({basePath: '/g'})
class GreetingController {
  @get('/hello', {response: z.object({greeting: z.string()})})
  hello() {
    return {greeting: 'hi'};
  }
}

describe('rest-explorer uninstall', () => {
  let app: RestApplication;
  let server: RestServer;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(GreetingController);
  });

  afterEach(async () => app.stop());

  async function startAndConnect() {
    await app.start();
    server = await app.restServer;
    client = supertest(server.url);
  }

  it('uninstall() makes every Express route 404 and leaves the rest of the app serving', async () => {
    const installed = await installExplorer(app);
    await startAndConnect();
    await client.get('/explorer/').expect(200);

    await installed.uninstall();

    await client.get('/explorer/').expect(404);
    await client.get('/explorer').expect(404);
    await client.get('/explorer/swagger-ui.css').expect(404);
    // The app itself is untouched.
    await client.get('/g/hello').expect(200);
    await client.get('/openapi.json').expect(200);
  });

  it('uninstall() removes the fetch-host handlers', async () => {
    const installed = await installExplorer(app);
    await startAndConnect();
    const before = await server
      .fetchHandler()
      .fetch(new Request('http://x/explorer/'));
    expect(before.status).toBe(200);

    await installed.uninstall();

    for (const path of [
      '/explorer/',
      '/explorer',
      '/explorer/swagger-ui.css',
    ]) {
      const res = await server
        .fetchHandler()
        .fetch(new Request(`http://x${path}`));
      expect(res.status, path).toBe(404);
    }
    // @api routes are untouched.
    const hello = await server
      .fetchHandler()
      .fetch(new Request('http://x/g/hello'));
    expect(hello.status).toBe(200);
  });

  it('uninstall() is idempotent', async () => {
    const installed = await installExplorer(app);
    await startAndConnect();

    await installed.uninstall();
    await expect(installed.uninstall()).resolves.toBeUndefined();
    await client.get('/explorer/').expect(404);
  });
});
