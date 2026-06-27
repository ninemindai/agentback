// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {sortListOfGroups} from '@agentback/common';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';
import {RestMiddlewareGroups} from '../../keys.js';

// Drives the ACTUAL `RestServer.fetchHandler()` onion (additive Web tier).
// The Express middleware chain is untouched; these exercise only the neutral
// `app.webMiddleware` path.

const Out = z.object({ok: z.boolean()});

@api({})
class OnionController {
  @get('/ping', {response: Out})
  async ping(): Promise<z.infer<typeof Out>> {
    return {ok: true};
  }
}

async function boot(
  configure: (app: RestApplication) => void,
  cors?: boolean,
): Promise<{app: RestApplication; host: ReturnType<RestServer['fetchHandler']>}> {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({
    port: 0,
    host: '127.0.0.1',
    ...(cors ? {cors: true} : {}),
  });
  app.restController(OnionController);
  configure(app);
  await app.start();
  const server = await app.getServer<RestServer>('RestServer');
  return {app, host: server.fetchHandler()};
}

describe('Web middleware onion (app.webMiddleware)', () => {
  let current: RestApplication | undefined;
  afterEach(async () => {
    await current?.stop();
    current = undefined;
  });

  it('executes middlewares in group-sorted order, not registration order', async () => {
    const order: string[] = [];
    const {app, host} = await boot(a => {
      // Register in a deliberately WRONG order: middleware (last) is registered
      // first, cors (first) last. Group sort must reorder to cors→parseBody→middleware.
      a.webMiddleware(
        async (_req, _ctx, next) => {
          order.push('middleware');
          return next();
        },
        {group: RestMiddlewareGroups.MIDDLEWARE},
      );
      a.webMiddleware(
        async (_req, _ctx, next) => {
          order.push('parseBody');
          return next();
        },
        {group: RestMiddlewareGroups.PARSE_BODY},
      );
      a.webMiddleware(
        async (_req, _ctx, next) => {
          order.push('cors');
          return next();
        },
        {group: RestMiddlewareGroups.CORS},
      );
    });
    current = app;

    const res = await host.fetch(new Request('http://x/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
    expect(order).toEqual(['cors', 'parseBody', 'middleware']);

    // Parity: the order matches the Express chain's sortListOfGroups result for
    // the same three groups.
    const sorted = sortListOfGroups([
      RestMiddlewareGroups.CORS,
      RestMiddlewareGroups.PARSE_BODY,
      RestMiddlewareGroups.MIDDLEWARE,
    ]);
    expect(order).toEqual(sorted);
  });

  it('a middleware returning a Response without next() short-circuits the route', async () => {
    let routeRan = false;
    const {app, host} = await boot(a => {
      a.webMiddleware(async () => {
        return Response.json({intercepted: true}, {status: 418});
      });
      a.webMiddleware(async (_req, _ctx, next) => {
        // This runs after the short-circuiting one only if order places it
        // downstream; assert it is never reached because the first returns.
        routeRan = true;
        return next();
      });
    });
    current = app;

    const res = await host.fetch(new Request('http://x/ping'));
    expect(res.status).toBe(418);
    expect(await res.json()).toEqual({intercepted: true});
    // The downstream middleware (and the route handler) never ran.
    expect(routeRan).toBe(false);
  });

  it('zero web middleware: fetchHandler still works', async () => {
    const {app, host} = await boot(() => {});
    current = app;
    const res = await host.fetch(new Request('http://x/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ok: true});
  });
});

describe('built-in CORS WebMiddleware', () => {
  let current: RestApplication | undefined;
  afterEach(async () => {
    await current?.stop();
    current = undefined;
  });

  it('OPTIONS preflight returns 204 with access-control-allow-* headers', async () => {
    const {app, host} = await boot(() => {}, true);
    current = app;

    const res = await host.fetch(
      new Request('http://x/ping', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-custom',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(res.headers.get('access-control-allow-methods')).toBeTruthy();
    expect(res.headers.get('access-control-allow-headers')).toBe('x-custom');
  });

  it('a normal request gets the CORS allow-origin header on its response', async () => {
    const {app, host} = await boot(() => {}, true);
    current = app;

    const res = await host.fetch(
      new Request('http://x/ping', {
        headers: {origin: 'https://app.example.com'},
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://app.example.com',
    );
    expect(await res.json()).toEqual({ok: true});
  });
});
