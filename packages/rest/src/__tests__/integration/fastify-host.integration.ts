// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import Fastify, {type FastifyInstance} from 'fastify';
import type {AddressInfo} from 'node:net';
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';
import {installFastifyHost} from '../../host/fastify.js';

// Proves installFastifyHost mounts the AgentBack core as a NON-GREEDY fallback:
// a Fastify-native route front-runs, AgentBack `@api` routes are served via the
// wildcard fallback, and a truly unmatched path yields the nested 404 envelope.
// Driven over a REAL socket (`fastify.listen({port:0})` + global fetch) rather
// than `fastify.inject`: the body passthrough writes the Web Response back onto
// `reply.raw` after `reply.hijack()`, which exercises real socket semantics that
// the light-my-request mock does not fully reproduce.

const GreetPath = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});
const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string()});

@api({})
class FastifyHostController {
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

describe('installFastifyHost (non-greedy fallback)', () => {
  let app: RestApplication;
  let fastify: FastifyInstance;
  let base: string;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(FastifyHostController);
    await app.start();
    const server = await app.getServer<RestServer>('RestServer');

    fastify = Fastify();
    // A Fastify-native route, registered directly — must front-run the fallback.
    fastify.get('/native', async () => ({from: 'fastify'}));
    installFastifyHost(fastify, server.fetchHandler());
    await fastify.listen({port: 0, host: '127.0.0.1'});
    const {port} = fastify.server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await fastify.close();
    await app.stop();
  });

  it('serves a Fastify-native route (front-runs the AgentBack fallback)', async () => {
    const res = await fetch(`${base}/native`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({from: 'fastify'});
  });

  it('falls through to an AgentBack @api GET route with a path param', async () => {
    const res = await fetch(`${base}/greet/Ada`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({greeting: 'Hello, Ada!'});
  });

  it('passes the raw body through to an AgentBack @api POST route', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: 'hi'}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({echoed: 'hi'});
  });

  it('returns the nested 404 envelope for a path neither side matches', async () => {
    const res = await fetch(`${base}/no-such-route`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {code: 'not_found', message: 'Not Found'},
    });
  });
});
