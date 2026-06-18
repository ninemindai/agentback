// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * EdgeRestApplication: the fetch/edge host. Defaults to listener:'native', so
 * start() mounts NO Express (nothing pulls the Node-only express runtime) and
 * the app serves through fetchHandler(). It does not expose the Express-only
 * app.middleware / app.expressMiddleware — those live on RestApplication.
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {
  EdgeRestApplication,
  RestApplication,
} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';

const PingOut = z.object({pong: z.boolean()});

@api({})
class PingController {
  @get('/ping', {response: PingOut})
  async ping(): Promise<z.infer<typeof PingOut>> {
    return {pong: true};
  }
}

describe('EdgeRestApplication', () => {
  it('defaults to the native listener: serves via fetchHandler, mounts NO Express', async () => {
    const app = new EdgeRestApplication({rest: {listen: false}});
    app.restController(PingController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');

    // The Express app is never created (ensureExpressApp not called).
    expect((server as unknown as {_app?: unknown})._app).toBeUndefined();
    expect(server.listener).toBe('native');

    const res = await server.fetchHandler().fetch(new Request('http://x/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({pong: true});
  });

  it('forces native even if rest.listener is set to express', async () => {
    const app = new EdgeRestApplication({
      // deliberately contradictory — the edge class wins.
      rest: {listen: false, listener: 'express'},
    });
    app.restController(PingController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');
    expect(server.listener).toBe('native');
  });

  it('does NOT expose the Express-only middleware methods', () => {
    const edge = new EdgeRestApplication() as unknown as {
      expressMiddleware?: unknown;
      middleware?: unknown;
    };
    expect(edge.expressMiddleware).toBeUndefined();
    // RestApplication (Express host) DOES have them — proves the split.
    const express = new RestApplication() as unknown as {
      expressMiddleware?: unknown;
    };
    expect(typeof express.expressMiddleware).toBe('function');
  });
});
