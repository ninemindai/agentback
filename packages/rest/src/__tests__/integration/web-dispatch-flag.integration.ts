// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';

// Exercises the `rest.dispatch` flag END-TO-END through the live Express server
// (supertest), not just `fetchHandler()`. The SAME controller is booted twice —
// once in 'express' mode, once in 'web' mode — and the two surfaces must return
// byte-identical results, status codes, and error envelopes. This is the flag's
// acceptance test; the full AGENTBACK_REST_DISPATCH=web suite run is the
// exhaustive parity arbiter.

const Path = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});
const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string()});

@api({})
class FlagController {
  @get('/greet/{name}', {path: Path, response: Greeting})
  async greet(input: {
    path: z.infer<typeof Path>;
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

async function boot(dispatch: 'express' | 'web') {
  const app = new RestApplication({rest: {dispatch}});
  app
    .configure('servers.RestServer')
    .to({port: 0, host: '127.0.0.1', dispatch});
  app.restController(FlagController);
  await app.start();
  return {
    app,
    client: supertest((await app.restServer).url),
    stop: () => app.stop(),
  };
}

describe('rest.dispatch flag (Express server)', () => {
  let express: Awaited<ReturnType<typeof boot>>;
  let web: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    express = await boot('express');
    web = await boot('web');
  });
  afterAll(async () => {
    await express.stop();
    await web.stop();
  });

  it('returns identical success bodies on both dispatch modes', async () => {
    const e = await express.client.get('/greet/Ada').expect(200);
    const w = await web.client.get('/greet/Ada').expect(200);
    expect(w.body).toEqual(e.body);
    expect(w.body).toEqual({greeting: 'Hello, Ada!'});
  });

  it('round-trips a JSON body identically on both dispatch modes', async () => {
    const e = await express.client.post('/echo').send({text: 'hi'}).expect(200);
    const w = await web.client.post('/echo').send({text: 'hi'}).expect(200);
    expect(w.body).toEqual(e.body);
    expect(w.body).toEqual({echoed: 'hi'});
  });

  it('emits identical validation error envelopes on both dispatch modes', async () => {
    const e = await express.client.post('/echo').send({}).expect(422);
    const w = await web.client.post('/echo').send({}).expect(422);
    expect(w.status).toBe(e.status);
    expect(w.body.error.code).toBe(e.body.error.code);
    expect(w.body.error.details?.[0]).toMatchObject({path: ['text']});
    expect(e.body.error.details?.[0]).toMatchObject({path: ['text']});
  });

  it('defaults to express (no behavior change) when the flag is unset', async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(FlagController);
    await app.start();
    try {
      const client = supertest((await app.restServer).url);
      await client.get('/greet/Bo').expect(200, {greeting: 'Hello, Bo!'});
    } finally {
      await app.stop();
    }
  });
});
