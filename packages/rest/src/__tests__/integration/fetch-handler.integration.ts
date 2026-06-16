// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {AgentError, ErrorCodes, api, get, post} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';
import type {FetchHost} from '../../host/fetch.js';

// Unlike `web-parity.integration.ts` (which hand-builds RouteValues), this drives
// the ACTUAL `RestServer.fetchHandler()` — so it proves that `collectRoutes`
// reads the route registry and produces the right templates, schemas, basePath
// prefixes, and success statuses. Express is the reference; the fetch handler
// must match it byte-for-byte. `@agentback/testing` would be circular (it depends
// on `rest`), so this boots a RestApplication directly: supertest drives the live
// Express surface and `server.fetchHandler()` drives the Web surface, both over
// one DI graph.

// Schemas declared ONCE and reused in the decorators — parity only holds if both
// surfaces validate against the same schema objects.
const GreetPath = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});

const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string()});

const MakePath = z.object({name: z.string().min(1).max(64)});
const Made = z.object({made: z.string()});

// A controller with a non-empty basePath so the prefix is exercised end-to-end
// through `collectRoutes`.
@api({basePath: '/v1'})
class FetchController {
  // Path-param success route + response schema.
  @get('/greet/{name}', {path: GreetPath, response: Greeting})
  async greet(input: {
    path: z.infer<typeof GreetPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  // Declared 201 — proves `collectRoutes` derives the success status.
  @post('/make/{name}', {path: MakePath, response: Made, status: 201})
  async make(input: {
    path: z.infer<typeof MakePath>;
  }): Promise<z.infer<typeof Made>> {
    return {made: input.path.name};
  }

  // Input-validation-failure route: an empty body trips min(1).
  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text};
  }

  // Handler throws a client-correctable AgentError.
  @get('/boom')
  async boom(): Promise<never> {
    throw new AgentError('You must provide a real name.', {
      code: ErrorCodes.INVALID_INPUT,
    });
  }
}

describe('Express<->Fetch parity via the route registry', () => {
  let app: RestApplication;
  let http: ReturnType<typeof supertest>;
  let host: FetchHost;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(FetchController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');
    http = supertest(server.url);
    // Built from the registry (collectRoutes) — the unit under test.
    host = server.fetchHandler();
  });

  afterAll(async () => {
    await app.stop();
  });

  it('basePath path-param success route is byte-identical', async () => {
    const r1 = await http.get('/v1/greet/Ada');
    const r2 = await host.fetch(new Request('http://x/v1/greet/Ada'));
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({greeting: 'Hello, Ada!'});
  });

  it('declared 201 success status is derived from the registry', async () => {
    const r1 = await http.post('/v1/make/Bee').send({});
    const r2 = await host.fetch(
      new Request('http://x/v1/make/Bee', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: '{}',
      }),
    );
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(201);
    expect(r1.body).toEqual({made: 'Bee'});
  });

  it('input-validation failure (invalid body) is byte-identical', async () => {
    const r1 = await http.post('/v1/echo').send({text: ''}); // min(1) fails
    const r2 = await host.fetch(
      new Request('http://x/v1/echo', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({text: ''}),
      }),
    );
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBeGreaterThanOrEqual(400);
  });

  it('valid body round-trips identically', async () => {
    const r1 = await http.post('/v1/echo').send({text: 'hi'});
    const r2 = await host.fetch(
      new Request('http://x/v1/echo', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({text: 'hi'}),
      }),
    );
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({echoed: 'hi'});
  });

  it('thrown AgentError is byte-identical', async () => {
    const r1 = await http.get('/v1/boom');
    const r2 = await host.fetch(new Request('http://x/v1/boom'));
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(400);
  });

  it('unmatched route yields the flat 404 envelope', async () => {
    const r = await host.fetch(new Request('http://x/no-such-route'));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({
      error: {code: 'not_found', message: 'Not Found'},
    });
  });
});
