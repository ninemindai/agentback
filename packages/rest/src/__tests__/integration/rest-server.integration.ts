// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import type {Response} from 'express';
import createError from 'http-errors';
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {inject} from '@agentback/core';
import {RestApplication} from '../../rest.application.js';
import {RestServer} from '../../rest.server.js';

const Greeting = z.object({greeting: z.string()});
const HelloPath = z.object({name: z.string().min(1).max(64)});
const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string()});
const LimitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100),
});
const LimitOut = z.object({limit: z.number().int()});

@api({basePath: '/greet'})
class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text};
  }

  @get('/limit', {query: LimitQuery, response: LimitOut})
  async limit(input: {
    query: z.infer<typeof LimitQuery>;
  }): Promise<{limit: number}> {
    return {limit: input.query.limit};
  }

  @get('/explode')
  explode(): never {
    throw new Error('database password leaked');
  }

  @get('/missing')
  missing(): never {
    throw createError(404, 'no such greeting');
  }
}

describe('RestServer (integration)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(GreetingController);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => {
    await app.stop();
  });

  describe('happy paths', () => {
    it('GET /greet/hello/{name} returns the greeting', async () => {
      const r = await client.get('/greet/hello/world').expect(200);
      expect(r.body).toEqual({greeting: 'Hello, world!'});
    });

    it('POST /greet/echo round-trips the text', async () => {
      const r = await client.post('/greet/echo').send({text: 'hi'}).expect(200);
      expect(r.body).toEqual({echoed: 'hi'});
    });

    it('GET /greet/limit coerces the query string to a number', async () => {
      const r = await client.get('/greet/limit?limit=42').expect(200);
      expect(r.body).toEqual({limit: 42});
    });
  });

  describe('validation failures', () => {
    it('422 on body too short', async () => {
      const r = await client.post('/greet/echo').send({text: ''}).expect(422);
      expect(r.body.error.details?.[0]).toMatchObject({
        path: ['text'],
        code: 'too_small',
      });
    });

    it('422 on missing body field', async () => {
      const r = await client.post('/greet/echo').send({}).expect(422);
      expect(r.body.error.details?.[0]).toMatchObject({
        path: ['text'],
        code: 'invalid_type',
      });
    });

    it('400 on invalid query (limit > max)', async () => {
      const r = await client.get('/greet/limit?limit=999').expect(400);
      expect(r.body.error.details?.[0]).toMatchObject({code: 'too_big'});
    });

    it('400 on missing required query', async () => {
      const r = await client.get('/greet/limit').expect(400);
      expect(r.body.error.statusCode).toBe(400);
    });
  });

  describe('OpenAPI document', () => {
    it('serves /openapi.json with version 3.1.1', async () => {
      const r = await client.get('/openapi.json').expect(200);
      expect(r.body.openapi).toBe('3.1.1');
      expect(r.body.paths['/greet/hello/{name}']).toBeDefined();
      expect(r.body.paths['/greet/echo']).toBeDefined();
    });

    it('emits a Zod-derived schema with constraints intact', async () => {
      const r = await client.get('/openapi.json').expect(200);
      const echo = r.body.paths['/greet/echo'].post;
      const schema = echo.requestBody.content['application/json'].schema;
      expect(schema.properties.text).toMatchObject({
        type: 'string',
        minLength: 1,
        maxLength: 280,
      });
    });
  });

  describe('error response shape', () => {
    it('404 for unknown route', async () => {
      await client.get('/no/such/route').expect(404);
    });

    it('sanitizes accidental 500 messages', async () => {
      const r = await client.get('/greet/explode').expect(500);
      expect(r.body.error.code).toBe('internal_error');
      expect(r.body.error.message).toBe('Internal Server Error');
      expect(JSON.stringify(r.body)).not.toContain('database password leaked');
    });

    it('preserves intentional 4xx messages', async () => {
      const r = await client.get('/greet/missing').expect(404);
      expect(r.body.error.message).toBe('no such greeting');
    });
  });
});

describe('RestServer (@inject on method params)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const FooOut = z.object({val: z.string()});

    @api({basePath: '/d'})
    class DiController {
      // No input schemas declared → slot 0 is free for @inject.
      @get('/foo', {response: FooOut})
      async foo(
        @inject('di.value') val: string,
      ): Promise<z.infer<typeof FooOut>> {
        return {val};
      }
    }

    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.bind('di.value').to('injected!');
    app.restController(DiController);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => app.stop());

  it('resolves @inject() on method parameters from the request context', async () => {
    const r = await client.get('/d/foo').expect(200);
    expect(r.body).toEqual({val: 'injected!'});
  });
});

describe('RestServer (input bundle + @inject mixed)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    const EchoBody = z.object({text: z.string().min(1)});
    const EchoOut = z.object({echoed: z.string(), tag: z.string()});

    @api({basePath: '/m'})
    class Mixed {
      @post('/echo', {body: EchoBody, response: EchoOut})
      async echo(
        input: {body: z.infer<typeof EchoBody>},
        @inject('di.tag') tag: string,
      ): Promise<z.infer<typeof EchoOut>> {
        return {echoed: input.body.text, tag};
      }
    }

    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.bind('di.tag').to('v1');
    app.restController(Mixed);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => app.stop());

  it('passes the validated body at slot 0 and an injected service at slot 1', async () => {
    const r = await client.post('/m/echo').send({text: 'hi'}).expect(200);
    expect(r.body).toEqual({echoed: 'hi', tag: 'v1'});
  });
});

describe('RestServer (cors: option)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    @api({basePath: '/c'})
    class PingController {
      @get('/ping', {response: z.object({pong: z.boolean()})})
      ping() {
        return {pong: true};
      }
    }

    app = new RestApplication({});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      cors: {
        origin: 'https://example.test',
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });
    app.restController(PingController);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => app.stop());

  it('responds to a preflight request with the configured origin', async () => {
    const r = await client
      .options('/c/ping')
      .set('Origin', 'https://example.test')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(r.headers['access-control-allow-origin']).toBe(
      'https://example.test',
    );
    expect(r.headers['access-control-allow-methods']).toMatch(/GET/);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  it('stamps allow-origin on actual responses', async () => {
    const r = await client
      .get('/c/ping')
      .set('Origin', 'https://example.test')
      .expect(200);
    expect(r.headers['access-control-allow-origin']).toBe(
      'https://example.test',
    );
  });
});

describe('RestServer (middleware chain via app.middleware)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    @api({basePath: '/m'})
    class PingController {
      @get('/ping', {response: z.object({pong: z.boolean()})})
      ping() {
        return {pong: true};
      }
    }

    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});

    // Cross-cutting middleware: stamps a header on every response.
    app.middleware(async (ctx, next) => {
      ctx.response.setHeader('x-stamped', 'yes');
      return next();
    });

    // LB-style middleware that short-circuits a probe request.
    app.middleware(async (ctx, next) => {
      if (ctx.request.path === '/__probe') {
        ctx.response.status(204).end();
        return ctx.response;
      }
      return next();
    });

    app.restController(PingController);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => app.stop());

  it('runs registered LB middleware before route handlers', async () => {
    const r = await client.get('/m/ping').expect(200);
    expect(r.body).toEqual({pong: true});
    expect(r.headers['x-stamped']).toBe('yes');
  });

  it('lets express middleware short-circuit before the router', async () => {
    await client.get('/__probe').expect(204);
  });
});

describe('RestServer (subclass dispatch override)', () => {
  it('lets a subclass wrap every result in an envelope via sendResult', async () => {
    class EnvelopeRestServer extends RestServer {
      protected override sendResult(
        res: Response,
        result: unknown,
        successStatus: number,
      ): void {
        if (successStatus !== 200) res.status(successStatus);
        if (successStatus === 204) {
          res.end();
        } else {
          res.json({ok: true, data: result});
        }
      }
    }

    @api({basePath: '/e'})
    class PingController {
      @get('/ping', {response: z.object({pong: z.boolean()})})
      ping() {
        return {pong: true};
      }
    }

    const app = new RestApplication({});
    app.server(EnvelopeRestServer);
    app.configure('servers.EnvelopeRestServer').to({
      port: 0,
      host: '127.0.0.1',
    });
    // RestApplication also boots its default RestServer; pin it to an
    // ephemeral port too or the test collides with anything on :3000.
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(PingController);
    await app.start();
    const server = await app.get<InstanceType<typeof EnvelopeRestServer>>(
      'servers.EnvelopeRestServer',
    );
    const c = supertest(server.url);
    try {
      const r = await c.get('/e/ping').expect(200);
      expect(r.body).toEqual({ok: true, data: {pong: true}});
    } finally {
      await app.stop();
    }
  });
});

describe('RestServer (registration-time guardrails)', () => {
  it('throws when URL placeholders do not match the path schema', async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});

    @api({basePath: '/g'})
    class Bad {
      @get('/users/{id}', {
        path: z.object({userId: z.string()}),
        response: z.object({}),
      })
      async getOne(_input: {path: {userId: string}}) {
        return {};
      }
    }
    app.restController(Bad);
    await expect(app.start()).rejects.toThrow(
      /path placeholders don't match the path schema/,
    );
    if (app.getSync<{listening?: boolean}>('servers.RestServer')?.listening) {
      await app.stop();
    }
  });

  it('throws when URL has placeholders but no path: schema is declared', async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});

    @api({basePath: '/g'})
    class NoSchema {
      @get('/users/{id}', {response: z.object({})})
      async getOne() {
        return {};
      }
    }
    app.restController(NoSchema);
    await expect(app.start()).rejects.toThrow(
      /URL has placeholders \{id\} but no path: schema is declared/,
    );
  });

  describe('serverless (listen: false)', () => {
    it('mounts routes but binds no port, exposing a ready expressApp', async () => {
      const app = new RestApplication({rest: {listen: false}});
      app.restController(GreetingController);
      await app.start();
      const server = await app.restServer;

      // start() resolved without binding a TCP listener.
      expect(server.listening).toBe(false);

      // ...yet the routes are fully mounted, so the bare Express app
      // (the seam a serverless platform would `export default`) serves them.
      const res = await supertest(server.expressApp).get('/greet/hello/World');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({greeting: 'Hello, World!'});

      // Framework routes are mounted too.
      const spec = await supertest(server.expressApp).get('/openapi.json');
      expect(spec.status).toBe(200);

      await app.stop();
    });
  });
});
