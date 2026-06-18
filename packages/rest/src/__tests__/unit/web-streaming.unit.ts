// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {Context} from '@agentback/context';
import {CoreTags} from '@agentback/core';
import {Router} from '../../web/router.js';
import {createFetchHost} from '../../host/fetch.js';
import {RestHandler} from '../../web/rest-handler.js';
import type {RouteValue} from '../../web/route-value.js';

const Tick = z.object({n: z.number()});

class StreamController {
  async *ticks() {
    yield {n: 1};
    yield {n: 2};
    yield {n: 3};
  }

  async *ticksJsonl() {
    yield {n: 10};
    yield {n: 20};
  }

  // Second item violates the `streamOf` schema (n is a string).
  async *liar(): AsyncGenerator<unknown> {
    yield {n: 1};
    yield {n: 'not-a-number'};
    yield {n: 3};
  }

  // Throws after emitting one valid item (mid-stream failure).
  async *blows(): AsyncGenerator<unknown> {
    yield {n: 1};
    throw new Error('upstream exploded');
  }
}

function buildHost() {
  const ctx = new Context('test-root');
  ctx
    .bind('controllers.StreamController')
    .toClass(StreamController)
    .tag(CoreTags.CONTROLLER);
  const handler = new RestHandler(ctx);
  const router = new Router<RouteValue>();
  const route = (
    template: string,
    methodName: string,
    format?: 'sse' | 'jsonl',
  ) =>
    router.add({
      method: 'GET',
      template,
      value: {
        ctor: StreamController,
        methodName,
        schemas: {streamOf: Tick, ...(format ? {format} : {})},
        successStatus: 200,
      },
    });
  route('/ticks', 'ticks');
  route('/ticks-jsonl', 'ticksJsonl', 'jsonl');
  route('/liar', 'liar');
  route('/blows', 'blows');
  return createFetchHost({router, dispatch: handler.dispatch});
}

describe('RestHandler streaming', () => {
  it('SSE: emits text/event-stream with framed data lines in order', async () => {
    const host = buildHost();
    const res = await host.fetch(
      new Request('http://x/ticks', {method: 'GET'}),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toBe('data: {"n":1}\n\ndata: {"n":2}\n\ndata: {"n":3}\n\n');
  });

  it('JSONL: emits application/jsonl with newline-delimited items', async () => {
    const host = buildHost();
    const res = await host.fetch(
      new Request('http://x/ticks-jsonl', {method: 'GET'}),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/jsonl');
    const text = await res.text();
    expect(text).toBe('{"n":10}\n{"n":20}\n');
  });

  it('item-validation failure mid-stream: frames an error and stops', async () => {
    const host = buildHost();
    const res = await host.fetch(new Request('http://x/liar', {method: 'GET'}));
    expect(res.status).toBe(200);
    const text = await res.text();
    // First valid item is emitted, then a terminal error frame; the third
    // (valid) item never appears because iteration stopped.
    expect(text).toContain('data: {"n":1}\n\n');
    expect(text).toContain('event: error\n');
    expect(text).not.toContain('{"n":3}');
    const errLine = text.split('\n').find(l => l.startsWith('data: {"error"'));
    expect(errLine).toBeDefined();
    const payload = JSON.parse(errLine!.slice('data: '.length)) as {
      error: {statusCode: number; message: string};
    };
    expect(payload.error.statusCode).toBe(500);
    expect(payload.error.message).toBe(
      'Stream item failed response validation.',
    );
  });

  it('mid-stream throw: frames the error envelope and closes', async () => {
    const host = buildHost();
    const res = await host.fetch(
      new Request('http://x/blows', {method: 'GET'}),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('data: {"n":1}\n\n');
    expect(text).toContain('event: error\n');
    const errLine = text.split('\n').find(l => l.startsWith('data: {"error"'));
    const payload = JSON.parse(errLine!.slice('data: '.length)) as {
      error: {statusCode: number};
    };
    expect(payload.error.statusCode).toBe(500);
  });
});
