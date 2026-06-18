// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {Router} from '../../web/router.js';
import {createFetchHost} from '../../host/fetch.js';
import {createNodeListener} from '../../host/node.js';

// Walking skeleton: Router -> FetchHost -> Node listener, over a real socket,
// driven with the global fetch. Exercises both conversion directions plus the
// HTTP edge cases that break naive adapters (multi Set-Cookie, HEAD, streaming).
const router = new Router<string>();
router.add({method: 'GET', template: '/greet/{name}', value: 'greet'});
router.add({method: 'POST', template: '/echo', value: 'echo'});
router.add({method: 'GET', template: '/multi', value: 'multi'});
router.add({method: 'GET', template: '/stream', value: 'stream'});
router.add({method: 'HEAD', template: '/head', value: 'head'});

const host = createFetchHost({
  router,
  dispatch: async (match, req) => {
    switch (match.value) {
      case 'echo': {
        const body = (await req.json()) as {text: string};
        return Response.json({echoed: body.text}, {status: 201});
      }
      case 'multi':
        return new Response(null, {
          status: 204,
          headers: new Headers([
            ['set-cookie', 'a=1; Path=/'],
            ['set-cookie', 'b=2; Path=/'],
          ]),
        });
      case 'stream': {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode('hello '));
            controller.enqueue(enc.encode('world'));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {'content-type': 'text/plain'},
        });
      }
      case 'head':
        return new Response('should-not-reach-client', {
          headers: {'x-marker': 'ok'},
        });
      default:
        return Response.json({greeting: `Hello, ${match.params.name}!`});
    }
  },
});

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(createNodeListener(host));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const {port} = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

describe('createNodeListener (end-to-end)', () => {
  it('round-trips a GET with a path param', async () => {
    const res = await fetch(`${base}/greet/Ada`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({greeting: 'Hello, Ada!'});
  });

  it('round-trips a POST body and a non-200 status', async () => {
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text: 'hi'}),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({echoed: 'hi'});
  });

  it('returns the nested 404 envelope for unmatched paths', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {code: 'not_found', message: 'Not Found'},
    });
  });

  it('preserves multiple Set-Cookie headers (D1 regression)', async () => {
    const res = await fetch(`${base}/multi`);
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('round-trips a streaming ReadableStream response body', async () => {
    const res = await fetch(`${base}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('hello world');
  });

  it('sends headers but no body for a HEAD request', async () => {
    const res = await fetch(`${base}/head`, {method: 'HEAD'});
    expect(res.status).toBe(200);
    expect(res.headers.get('x-marker')).toBe('ok');
    expect(await res.text()).toBe('');
  });
});
