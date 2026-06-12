// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {createClient} from '../../client.js';
import {defineRoute} from '../../define-route.js';
import {ClientError} from '../../errors.js';
import {parseSSE, type SSEEvent} from '../../sse.js';

/** Build a ReadableStream from string chunks (arbitrary chunk boundaries). */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const evt of parseSSE(body)) out.push(evt);
  return out;
}

describe('parseSSE', () => {
  it('parses simple data frames', async () => {
    const events = await collect(
      streamOf('data: {"n":1}\n\ndata: {"n":2}\n\n'),
    );
    expect(events).toEqual([{data: '{"n":1}'}, {data: '{"n":2}'}]);
  });

  it('handles chunk boundaries inside a frame', async () => {
    const events = await collect(streamOf('data: {"n', '":1}\n', '\n'));
    expect(events).toEqual([{data: '{"n":1}'}]);
  });

  it('joins multi-line data fields with newlines', async () => {
    const events = await collect(streamOf('data: a\ndata: b\n\n'));
    expect(events).toEqual([{data: 'a\nb'}]);
  });

  it('carries event names and resets them between frames', async () => {
    const events = await collect(
      streamOf('event: error\ndata: x\n\ndata: y\n\n'),
    );
    expect(events).toEqual([{event: 'error', data: 'x'}, {data: 'y'}]);
  });

  it('ignores comment lines (heartbeats) and id/retry fields', async () => {
    const events = await collect(
      streamOf(': ping\n\nid: 7\nretry: 100\ndata: x\n\n'),
    );
    expect(events).toEqual([{data: 'x'}]);
  });

  it('handles CRLF framing', async () => {
    const events = await collect(streamOf('data: x\r\n\r\n'));
    expect(events).toEqual([{data: 'x'}]);
  });

  it('emits a complete trailing frame at end of stream', async () => {
    const events = await collect(streamOf('data: tail\n'));
    expect(events).toEqual([{data: 'tail'}]);
  });
});

// ---- route.stream() against a stubbed fetch ----

const Tick = z.object({n: z.number().int()});

function clientWithSSE(body: string, init?: ResponseInit) {
  const calls: {url: string; init: RequestInit}[] = [];
  const client = createClient({
    baseURL: 'http://test.local',
    fetch: (async (url: string | URL | Request, i?: RequestInit) => {
      calls.push({url: String(url), init: i ?? {}});
      return new Response(streamOf(body), {
        status: 200,
        headers: {'content-type': 'text/event-stream'},
        ...init,
      });
    }) as typeof globalThis.fetch,
  });
  return {client, calls};
}

describe('route.stream()', () => {
  const ticks = defineRoute('GET', '/ticks', {streamOf: Tick});

  it('yields validated items', async () => {
    const {client, calls} = clientWithSSE('data: {"n":1}\n\ndata: {"n":2}\n\n');
    const seen: {n: number}[] = [];
    for await (const item of ticks.stream(client)) seen.push(item);
    expect(seen).toEqual([{n: 1}, {n: 2}]);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['accept']).toBe('text/event-stream');
  });

  it('throws ClientError on event: error frames', async () => {
    const {client} = clientWithSSE(
      'data: {"n":1}\n\nevent: error\ndata: {"error":{"statusCode":500,"message":"boom"}}\n\n',
    );
    const seen: {n: number}[] = [];
    await expect(async () => {
      for await (const item of ticks.stream(client)) seen.push(item);
    }).rejects.toThrow(/boom/);
    expect(seen).toEqual([{n: 1}]);
  });

  it('throws ClientError when an item fails validation', async () => {
    const {client} = clientWithSSE('data: {"n":"zap"}\n\n');
    await expect(async () => {
      for await (const _ of ticks.stream(client)) void _;
    }).rejects.toThrow(ClientError);
  });

  it('throws ClientError with server message on non-2xx', async () => {
    const client = createClient({
      baseURL: 'http://test.local',
      fetch: (async () =>
        new Response(JSON.stringify({error: {message: 'nope'}}), {
          status: 403,
          headers: {'content-type': 'application/json'},
        })) as typeof globalThis.fetch,
    });
    await expect(async () => {
      for await (const _ of ticks.stream(client)) void _;
    }).rejects.toThrow(/nope/);
  });
});

// ---- route.stream() over an application/jsonl body ----

function clientWithJSONL(body: string, init?: ResponseInit) {
  const calls: {url: string; init: RequestInit}[] = [];
  const client = createClient({
    baseURL: 'http://test.local',
    fetch: (async (url: string | URL | Request, i?: RequestInit) => {
      calls.push({url: String(url), init: i ?? {}});
      return new Response(streamOf(body), {
        status: 200,
        headers: {'content-type': 'application/jsonl'},
        ...init,
      });
    }) as typeof globalThis.fetch,
  });
  return {client, calls};
}

describe('route.stream() with format: jsonl', () => {
  const ticks = defineRoute('GET', '/ticks', {
    streamOf: Tick,
    format: 'jsonl',
  });

  it('yields validated items and sets Accept: application/jsonl', async () => {
    const {client, calls} = clientWithJSONL('{"n":1}\n{"n":2}\n');
    const seen: {n: number}[] = [];
    for await (const item of ticks.stream(client)) seen.push(item);
    expect(seen).toEqual([{n: 1}, {n: 2}]);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['accept']).toBe('application/jsonl');
  });

  it('tolerates a trailing line with no newline', async () => {
    const {client} = clientWithJSONL('{"n":1}\n{"n":2}');
    const seen: {n: number}[] = [];
    for await (const item of ticks.stream(client)) seen.push(item);
    expect(seen).toEqual([{n: 1}, {n: 2}]);
  });

  it('throws ClientError on a terminal error line', async () => {
    const {client} = clientWithJSONL(
      '{"n":1}\n{"error":{"statusCode":500,"message":"boom"}}\n',
    );
    const seen: {n: number}[] = [];
    await expect(async () => {
      for await (const item of ticks.stream(client)) seen.push(item);
    }).rejects.toThrow(/boom/);
    expect(seen).toEqual([{n: 1}]);
  });

  it('throws ClientError when an item fails validation', async () => {
    const {client} = clientWithJSONL('{"n":"zap"}\n');
    await expect(async () => {
      for await (const _ of ticks.stream(client)) void _;
    }).rejects.toThrow(ClientError);
  });

  it('throws ClientError with server message on non-2xx', async () => {
    const client = createClient({
      baseURL: 'http://test.local',
      fetch: (async () =>
        new Response(JSON.stringify({error: {message: 'nope'}}), {
          status: 403,
          headers: {'content-type': 'application/json'},
        })) as typeof globalThis.fetch,
    });
    await expect(async () => {
      for await (const _ of ticks.stream(client)) void _;
    }).rejects.toThrow(/nope/);
  });
});
