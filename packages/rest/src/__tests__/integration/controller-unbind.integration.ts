// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Unbinding a controller retracts its routes as 404 on BOTH hosts — not a 500
 * from the resolver throw. Routes are baked into Express (and the memoized
 * fetch router) at start(), so retraction is enforced per request by a
 * bound-check gate in the handlers. This is the controller half of the
 * revertible-install contract (docs/proposals/revertible-installs.md): an
 * install helper that registered a controller can retract it with unbind()
 * and the API is honestly gone.
 */

import {afterEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';

@api({basePath: '/w'})
class WidgetController {
  @get('/widget', {response: z.object({ok: z.boolean()})})
  widget() {
    return {ok: true};
  }
}

@api({basePath: '/s'})
class StableController {
  @get('/stable', {response: z.object({ok: z.boolean()})})
  stable() {
    return {ok: true};
  }
}

describe('controller unbind retracts routes', () => {
  let app: RestApplication;

  afterEach(async () => app.stop());

  it('Express host: unbound controller routes 404, others keep serving', async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(WidgetController);
    app.restController(StableController);
    await app.start();
    const server = await app.restServer;
    const client = supertest(server.url);
    await client.get('/w/widget').expect(200);

    app.unbind('controllers.WidgetController');

    await client.get('/w/widget').expect(404);
    await client.get('/s/stable').expect(200);
  });

  it('fetch host: unbound controller routes 404 with the canonical envelope', async () => {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(WidgetController);
    app.restController(StableController);
    await app.start();
    const server = await app.restServer;
    const before = await server
      .fetchHandler()
      .fetch(new Request('http://x/w/widget'));
    expect(before.status).toBe(200);

    app.unbind('controllers.WidgetController');

    const after = await server
      .fetchHandler()
      .fetch(new Request('http://x/w/widget'));
    expect(after.status).toBe(404);
    const body = (await after.json()) as {error?: {code?: string}};
    expect(body.error?.code).toBe('not_found');
    const stable = await server
      .fetchHandler()
      .fetch(new Request('http://x/s/stable'));
    expect(stable.status).toBe(200);
  });
});
