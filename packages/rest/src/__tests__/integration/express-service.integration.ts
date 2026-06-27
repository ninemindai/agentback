// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Proves the ExpressService DI seam: RestServer obtains the Express host from an
 * injected {@link ExpressService} when one is bound (via EXPRESS_SERVICE_KEY),
 * and otherwise falls back to its default Express runtime (parity — the path the
 * rest of the suite exercises).
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import express from 'express';
import cors from 'cors';
import {
  EXPRESS_SERVICE_KEY,
  registerExpressMiddleware,
  toExpressMiddleware,
  type ExpressService,
} from '@agentback/middleware';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';

const PingOut = z.object({pong: z.boolean()});

@api({})
class PingController {
  @get('/ping', {response: PingOut})
  async ping(): Promise<z.infer<typeof PingOut>> {
    return {pong: true};
  }
}

describe('RestServer — ExpressService DI seam', () => {
  it('uses the injected ExpressService (mounts on its app instance)', async () => {
    const stubApp = express();
    const stub: ExpressService = {
      app: stubApp,
      express,
      cors,
      registerExpressMiddleware,
      toExpressMiddleware,
    };
    const app = new RestApplication({rest: {listen: false}});
    app.bind(EXPRESS_SERVICE_KEY).to(stub);
    app.restController(PingController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');

    // RestServer mounted onto the INJECTED service's app, not a fresh one.
    expect(server.expressApp).toBe(stubApp);
  });

  it('falls back to the default Express runtime when none is bound (parity)', async () => {
    const app = new RestApplication({rest: {listen: false}});
    app.restController(PingController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');

    // A real Express app is present and serves, with nothing bound.
    expect(typeof server.expressApp.use).toBe('function');
  });
});
