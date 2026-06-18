// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import {
  REST_DISPATCH_HOOK_TAG,
  type RestDispatchHook,
  type RestDispatchInfo,
} from '../../keys.js';
import type {FetchHost} from '../../host/fetch.js';

// Parity arbiter for C2: a bound RestDispatchHook must fire identically on BOTH
// dispatch surfaces — the Express RestServer.dispatch path AND the runtime-
// neutral Web RestHandler path. The hook observes the neutral RestDispatchInfo
// (Web Request + responseHeaders collector), wraps the same pipeline scope, and
// its responseHeaders contribution must reach the client on each surface.

const Out = z.object({n: z.number()});

interface Observation {
  method: string;
  path: string;
  ctor: string;
  methodName: string;
  result: unknown;
}

@api({basePath: '/calc'})
class CalcController {
  @get('/double/{n}', {path: z.object({n: z.coerce.number()}), response: Out})
  async double(input: {path: {n: number}}): Promise<z.infer<typeof Out>> {
    return {n: input.path.n * 2};
  }
}

describe('Express<->Web dispatch-hook parity', () => {
  let app: RestApplication;
  let http: ReturnType<typeof supertest>;
  let web: FetchHost;
  const seen: Observation[] = [];

  // A spy hook: records what it observed off the neutral info, sets a response
  // header, and returns the wrapped result unchanged.
  const spy: RestDispatchHook = async (
    info: RestDispatchInfo,
    next,
  ): Promise<unknown> => {
    const url = new URL(info.request.url);
    const result = await next();
    seen.push({
      method: info.request.method,
      path: url.pathname,
      ctor: info.ctor.name,
      methodName: info.methodName,
      result,
    });
    info.responseHeaders.set('x-hook', 'fired');
    return result;
  };

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(CalcController);
    app.bind('hooks.spy').to(spy).tag(REST_DISPATCH_HOOK_TAG);
    await app.start();
    const server = await app.restServer;
    http = supertest(server.url);
    web = server.fetchHandler();
  });

  afterAll(async () => {
    await app.stop();
  });

  it('fires identically on Express and Web for the same route', async () => {
    const r1 = await http.get('/calc/double/21');
    const expressObs = seen.at(-1)!;

    const r2 = await web.fetch(new Request('http://x/calc/double/21'));
    const webObs = seen.at(-1)!;
    const b2 = await r2.json();

    // Same response on both surfaces.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body).toEqual({n: 42});
    expect(b2).toEqual({n: 42});

    // The hook observed equivalent info on both surfaces.
    expect(expressObs.method).toBe('GET');
    expect(webObs.method).toBe('GET');
    expect(expressObs.path).toBe('/calc/double/21');
    expect(webObs.path).toBe('/calc/double/21');
    expect(expressObs.ctor).toBe('CalcController');
    expect(webObs.ctor).toBe('CalcController');
    expect(expressObs.methodName).toBe('double');
    expect(webObs.methodName).toBe('double');
    // It wrapped the same result on both surfaces.
    expect(expressObs.result).toEqual({n: 42});
    expect(webObs.result).toEqual({n: 42});

    // The neutral responseHeaders contribution reached the client on each.
    expect(r1.headers['x-hook']).toBe('fired');
    expect(r2.headers.get('x-hook')).toBe('fired');
  });
});
