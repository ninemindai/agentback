// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {
  AgentError,
  ErrorCodes,
  api,
  get,
  post,
  type RouteSchemas,
} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import {RestHandler} from '../../web/rest-handler.js';
import {Router} from '../../web/router.js';
import type {RouteValue} from '../../web/route-value.js';
import {createFetchHost, type FetchHost} from '../../host/fetch.js';

// `@agentback/testing` would be circular here (it depends on `rest`), so this
// keystone test boots a RestApplication directly: supertest drives the live
// Express surface, and the app itself (an Application IS a Context) is handed to
// RestHandler for the Web surface — guaranteeing both sides share one DI graph.

// Schemas declared ONCE and reused in both the decorators and the RouteValues —
// parity only holds if both surfaces validate against the same schema objects.
const GreetPath = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});

const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string()});

const MakePath = z.object({name: z.string().min(1).max(64)});
const Made = z.object({made: z.string()});

const SearchQuery = z.object({
  q: z.string(),
  tag: z.array(z.string()).optional(),
});
const SearchOut = z.object({q: z.string(), tags: z.array(z.string())});

@api({basePath: '/p'})
class ParityController {
  // Success route: path param + response schema.
  @get('/greet/{name}', {path: GreetPath, response: Greeting})
  async greet(input: {
    path: z.infer<typeof GreetPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  // Input-validation-failure route: a body schema an invalid body trips.
  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text};
  }

  // Query-param parity: single-value + multi-value (repeated key → array).
  @get('/search', {query: SearchQuery, response: SearchOut})
  async search(input: {
    query: z.infer<typeof SearchQuery>;
  }): Promise<z.infer<typeof SearchOut>> {
    return {q: input.query.q, tags: input.query.tag ?? []};
  }

  // AgentError route: handler throws a client-correctable domain error.
  @get('/boom')
  async boom(): Promise<never> {
    throw new AgentError('You must provide a real name.', {
      code: ErrorCodes.INVALID_INPUT,
    });
  }

  // Success-status parity: declared 201.
  @post('/make/{name}', {path: MakePath, response: Made, status: 201})
  async make(input: {
    path: z.infer<typeof MakePath>;
  }): Promise<z.infer<typeof Made>> {
    return {made: input.path.name};
  }
}

describe('Express<->Web dispatch parity', () => {
  let app: RestApplication;
  let http: ReturnType<typeof supertest>;
  let web: FetchHost;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(ParityController);
    await app.start();
    const server = await app.restServer;
    http = supertest(server.url);

    // Build the Web side over the SAME DI context (the app IS a Context).
    const router = new Router<RouteValue>();
    const route = (
      method: string,
      template: string,
      methodName: string,
      schemas: RouteSchemas,
      successStatus: number,
    ) =>
      router.add({
        method,
        // Web templates carry the full path (basePath + route path).
        template: '/p' + template,
        value: {ctor: ParityController, methodName, schemas, successStatus},
      });

    // successStatus set explicitly per route (200 default, 201 where declared);
    // registry wiring that derives it is Part 3.
    route(
      'GET',
      '/greet/{name}',
      'greet',
      {path: GreetPath, response: Greeting},
      200,
    );
    route('POST', '/echo', 'echo', {body: EchoIn, response: EchoOut}, 200);
    route(
      'GET',
      '/search',
      'search',
      {query: SearchQuery, response: SearchOut},
      200,
    );
    route('GET', '/boom', 'boom', {}, 200);
    route(
      'POST',
      '/make/{name}',
      'make',
      {path: MakePath, response: Made},
      201,
    );

    const handler = new RestHandler(app);
    web = createFetchHost({router, dispatch: handler.dispatch});
  });

  afterAll(async () => {
    await app.stop();
  });

  it('success route (GET path param + response) is byte-identical', async () => {
    const r1 = await http.get('/p/greet/Ada');
    const r2 = await web.fetch(new Request('http://x/p/greet/Ada'));
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({greeting: 'Hello, Ada!'});
  });

  it('success-status route (declared 201) matches status + body', async () => {
    const r1 = await http.post('/p/make/Bee').send({});
    const r2 = await web.fetch(
      new Request('http://x/p/make/Bee', {
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
    const r1 = await http.post('/p/echo').send({text: ''}); // min(1) fails
    const r2 = await web.fetch(
      new Request('http://x/p/echo', {
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

  it('thrown AgentError is byte-identical', async () => {
    const r1 = await http.get('/p/boom');
    const r2 = await web.fetch(new Request('http://x/p/boom'));
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(400);
  });

  it('query single-value param parity', async () => {
    const r1 = await http.get('/p/search?q=hello');
    const r2 = await web.fetch(new Request('http://x/p/search?q=hello'));
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({q: 'hello', tags: []});
  });

  it('query multi-value param parity (repeated key → array)', async () => {
    const qs = 'q=hello&tag=a&tag=b';
    const r1 = await http.get(`/p/search?${qs}`);
    const r2 = await web.fetch(new Request(`http://x/p/search?${qs}`));
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    expect(r1.status).toBe(200);
    // Verify the array actually arrived — test would fail if repeats were collapsed.
    expect(r1.body).toEqual({q: 'hello', tags: ['a', 'b']});
  });
});
