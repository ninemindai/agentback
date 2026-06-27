// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {inject} from '@agentback/core';
import {RestApplication} from '../../rest.application.js';
import {RestBindings} from '../../keys.js';
import type {RestServer} from '../../rest.server.js';

// Proves rest.listener: 'native' serves the same surface as the Express
// listener — @api routes, /openapi.json — through a Node http server driven by
// createNodeListener(fetchHandler()), with no Express routing in the path.

const GreetPath = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});
const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string()});

@api({})
class NativeController {
  @get('/greet/{name}', {path: GreetPath, response: Greeting})
  async greet(input: {
    path: z.infer<typeof GreetPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text};
  }
}

describe("rest.listener: 'native'", () => {
  let app: RestApplication;
  let base: string;

  beforeAll(async () => {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.restController(NativeController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');
    base = server.url;
  });

  afterAll(async () => app.stop());

  it('serves a GET @api route with a path param', async () => {
    const res = await fetch(`${base}/greet/Ada`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({greeting: 'Hello, Ada!'});
  });

  it('serves a POST @api route with a JSON body', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: 'hi'}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({echoed: 'hi'});
  });

  it('serves /openapi.json', async () => {
    const res = await fetch(`${base}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {openapi: string; paths: object};
    expect(spec.openapi).toBe('3.1.1');
    expect(Object.keys(spec.paths)).toContain('/greet/{name}');
  });

  it('returns the nested 404 envelope for an unmatched path', async () => {
    const res = await fetch(`${base}/no-such-route`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {code: 'not_found', message: 'Not Found'},
    });
  });

  it('validation failure returns the agent error envelope', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {error: {code: string}};
    expect(body.error.code).toBe('invalid_body');
  });
});

describe("rest.listener: 'native' — guards Express-coupled routes", () => {
  it('throws at start() when a route injects the raw Express request', async () => {
    @api({})
    class RawController {
      @get('/raw')
      async raw(
        // Raw req injection — inherently Express-coupled.
        @inject(RestBindings.HTTP_REQUEST) _req: unknown,
      ): Promise<{ok: boolean}> {
        return {ok: true};
      }
    }

    const app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({port: 0, listener: 'native'});
    app.restController(RawController);
    // start() rejects from the native-listener guard before any port is bound;
    // the app is left mid-startup, so there's nothing to stop().
    await expect(app.start()).rejects.toThrow(/native.*cannot serve route/s);
  });
});

// Edge/serverless shape: `listen: false` + native. These guard the runtime
// edge-readiness fixes — a worker bundles clean yet must also (a) never touch
// Express at start() and (b) enforce the same start-time guardrails as Express.
describe("rest.listener: 'native' — edge (listen: false)", () => {
  const PingOut = z.object({pong: z.boolean()});

  it('start() mounts NO Express app yet still serves via fetchHandler()', async () => {
    @api({})
    class PingController {
      @get('/ping', {response: PingOut})
      async ping(): Promise<z.infer<typeof PingOut>> {
        return {pong: true};
      }
    }
    const app = new RestApplication({
      rest: {listen: false, listener: 'native'},
    });
    app.restController(PingController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');
    // The Express app is created lazily in ensureExpressApp(); native start()
    // must never trigger it (it would pull the Node-only express runtime —
    // fatal on a Worker isolate). The private `_app` field stays undefined.
    expect((server as unknown as {_app?: unknown})._app).toBeUndefined();
    // …and the fetch surface still serves the route.
    const res = await server.fetchHandler().fetch(new Request('http://x/ping'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({pong: true});
  });

  it('throws at start() on an Express-coupled route — even with listen:false', async () => {
    @api({})
    class RawController {
      @get('/raw')
      async raw(
        @inject(RestBindings.HTTP_REQUEST) _req: unknown,
      ): Promise<{ok: boolean}> {
        return {ok: true};
      }
    }
    const app = new RestApplication({
      rest: {listen: false, listener: 'native'},
    });
    app.restController(RawController);
    await expect(app.start()).rejects.toThrow(/native.*cannot serve route/s);
  });

  it('throws at start() on a placeholder/schema mismatch (parity with Express)', async () => {
    @api({})
    class BadPathController {
      // URL has {id} but declares no `path:` schema — the guardrail must fire
      // on the native path too (it runs in collectRoutes, forced at start()).
      @get('/item/{id}', {response: PingOut})
      async item(): Promise<z.infer<typeof PingOut>> {
        return {pong: true};
      }
    }
    const app = new RestApplication({
      rest: {listen: false, listener: 'native'},
    });
    app.restController(BadPathController);
    await expect(app.start()).rejects.toThrow(
      /placeholders \{id\} but no path: schema/s,
    );
  });
});
