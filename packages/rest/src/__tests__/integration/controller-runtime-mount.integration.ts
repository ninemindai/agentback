// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The additive counterpart of `controller-unbind.integration.ts`. Routes are
 * collected exactly once — `mountAllControllers()` in `start()`, and a memoized
 * fetch router — so a controller bound into a RUNNING app is bound but never
 * served. `refreshSurface()` re-derives from the live registry and closes that
 * asymmetry: retraction was already live from the other side.
 */

import {afterEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {refreshSurfaces} from '@agentback/core';
import {RestApplication} from '../../rest.application.js';

@api({basePath: '/s'})
class StableController {
  @get('/stable', {response: z.object({ok: z.boolean()})})
  stable() {
    return {ok: true};
  }
}

@api({basePath: '/late'})
class LateController {
  @get('/late', {response: z.object({who: z.string()})})
  late() {
    return {who: 'late'};
  }
}

describe('controller bound after start() is served once refreshed', () => {
  let app: RestApplication;

  afterEach(async () => app.stop());

  it('Express host: 404 before refresh, 200 after, stable route untouched', async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(StableController);
    await app.start();
    const server = await app.restServer;
    const client = supertest(server.url);
    await client.get('/s/stable').expect(200);

    // Bound into a RUNNING app: routes were collected at start(), so binding
    // alone changes nothing that is served.
    app.restController(LateController);
    await client.get('/late/late').expect(404);

    await refreshSurfaces(app);
    await client.get('/late/late').expect(200, {who: 'late'});
    await client.get('/s/stable').expect(200);
  });

  it('Express host: a repeated refresh does not double-mount', async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(StableController);
    await app.start();
    const server = await app.restServer;

    app.restController(LateController);
    await refreshSurfaces(app);
    const layersAfterFirst = (
      server.expressApp as unknown as {router: {stack: unknown[]}}
    ).router.stack.length;

    await refreshSurfaces(app);
    await refreshSurfaces(app);
    const layersAfterThird = (
      server.expressApp as unknown as {router: {stack: unknown[]}}
    ).router.stack.length;

    // Express appends and never replaces, so a non-idempotent mount would grow
    // the stack on every refresh and leave shadowed dead routes behind.
    expect(layersAfterThird).toBe(layersAfterFirst);
    await supertest(server.url).get('/late/late').expect(200);
  });

  it('native host: 404 before refresh, 200 after', async () => {
    // Port/host go in the constructor's `rest` key, NOT a separate
    // `configure().to({...})` — that replaces the whole config object and would
    // silently drop `listener: 'native'`, leaving the app on Express with the
    // fetch memo never built by start(), so the premise here would not hold.
    app = new RestApplication({
      rest: {listener: 'native', port: 0, host: '127.0.0.1'},
    });
    app.restController(StableController);
    await app.start();
    const server = await app.restServer;
    expect(server.listener).toBe('native');

    app.restController(LateController);
    const before = await server
      .fetchHandler()
      .fetch(new Request('http://x/late/late'));
    expect(before.status).toBe(404);

    await refreshSurfaces(app);
    const after = await server
      .fetchHandler()
      .fetch(new Request('http://x/late/late'));
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({who: 'late'});
  });

  it('Express host: an already-built fetch memo is refreshed too', async () => {
    // On Express, fetchHandler() is lazy — a serverless export builds the memo
    // on first use rather than at start(), so it goes stale the same way.
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(StableController);
    await app.start();
    const server = await app.restServer;
    await server.fetchHandler().fetch(new Request('http://x/s/stable'));

    app.restController(LateController);
    const before = await server
      .fetchHandler()
      .fetch(new Request('http://x/late/late'));
    expect(before.status).toBe(404);

    await refreshSurfaces(app);
    const after = await server
      .fetchHandler()
      .fetch(new Request('http://x/late/late'));
    expect(after.status).toBe(200);
  });

  it('a refreshed route can still be retracted by unbinding', async () => {
    // The two halves must compose: adding at runtime must not opt a route out
    // of the per-request liveness gate that retraction depends on.
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    await app.start();
    const server = await app.restServer;
    const client = supertest(server.url);

    app.restController(LateController);
    await refreshSurfaces(app);
    await client.get('/late/late').expect(200);

    app.unbind('controllers.LateController');
    await client.get('/late/late').expect(404);
  });
});
