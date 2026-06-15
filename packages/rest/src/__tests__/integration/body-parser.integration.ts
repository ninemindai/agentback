// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {api, post} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import {RestMiddlewareGroups} from '../../keys.js';
import type {RestServerConfig} from '../../types.js';

// A route with no body schema — body parsing is governed entirely by config,
// and a chain middleware observes whatever `req.body` parsing produced.
@api({})
class PingController {
  @post('/ping')
  ping() {
    return {ok: true};
  }
}

/**
 * Boot an app with the given `rest` config, registering a middleware (in the
 * default `middleware` group) that captures `req.body` for the `/ping` route.
 * Returns the supertest client, the capture getter, and a disposer.
 */
async function boot(rest: RestServerConfig) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1', ...rest});
  app.restController(PingController);

  let captured: unknown = 'UNSET';
  app.middleware(async (ctx, next) => {
    if (ctx.request.path === '/ping') captured = ctx.request.body;
    return next();
  });

  await app.start();
  const server = await app.restServer;
  return {
    client: supertest(server.url),
    captured: () => captured,
    stop: () => app.stop(),
  };
}

describe('RestServer body parsing (group model)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('parses JSON by default, and user middleware sees the parsed body', async () => {
    // Proves both: (a) JSON-on default, and (b) ordering — the default
    // `middleware` group runs AFTER `parseBody`, so it observes a parsed body.
    const {client, captured, stop: s} = await boot({});
    stop = s;
    await client.post('/ping').send({a: 1, b: 'two'}).expect(200);
    expect(captured()).toEqual({a: 1, b: 'two'});
  });

  it('mounts no parser when bodyParser:false (req.body stays unparsed)', async () => {
    const {client, captured, stop: s} = await boot({bodyParser: false});
    stop = s;
    await client
      .post('/ping')
      .set('Content-Type', 'application/json')
      .send('{"a":1}')
      .expect(200);
    // No JSON parser ran, so Express never populated req.body.
    expect(captured()).toBeUndefined();
  });

  it('accepts text/* bodies when text parsing is enabled', async () => {
    const {client, captured, stop: s} = await boot({
      bodyParser: {json: false, text: true},
    });
    stop = s;
    await client
      .post('/ping')
      .set('Content-Type', 'text/plain')
      .send('plain words')
      .expect(200);
    expect(captured()).toBe('plain words');
  });

  it('lets a caller run BEFORE parseBody via its own upstream group', async () => {
    // A middleware in its OWN group, ordered upstream of `parseBody`, sees the
    // raw unparsed body; the default-group middleware (which `parseBody` runs
    // ahead of) sees it parsed. NB: it must be a distinct group — putting it in
    // the default `middleware` group while pointing downstream at `parseBody`
    // would form a cycle (parseBody already runs before `middleware`).
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(PingController);

    let beforeBody: unknown = 'UNSET';
    let afterBody: unknown = 'UNSET';
    app.middleware(
      async (ctx, next) => {
        if (ctx.request.path === '/ping') beforeBody = ctx.request.body;
        return next();
      },
      {group: 'before-body', downstreamGroups: [RestMiddlewareGroups.PARSE_BODY]},
    );
    app.middleware(async (ctx, next) => {
      if (ctx.request.path === '/ping') afterBody = ctx.request.body;
      return next();
    });

    await app.start();
    stop = () => app.stop();
    const client = supertest((await app.restServer).url);
    await client.post('/ping').send({hi: true}).expect(200);

    expect(beforeBody).toBeUndefined(); // ran before the JSON parser
    expect(afterBody).toEqual({hi: true}); // ran after it
  });

  it('mounts CORS into the chain when enabled', async () => {
    const {client, stop: s} = await boot({cors: true});
    stop = s;
    const res = await client.post('/ping').send({}).expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});
