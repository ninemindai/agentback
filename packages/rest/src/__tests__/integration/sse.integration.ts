// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import createError from 'http-errors';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';

const Tick = z.object({n: z.number().int()});
const CountQuery = z.object({to: z.coerce.number().int().min(1).max(10)});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Set when the slow generator's finally block runs (disconnect cleanup). */
let slowCleanedUp = false;

@api({basePath: '/sse'})
class StreamController {
  @get('/count', {query: CountQuery, streamOf: Tick})
  async *count(input: {
    query: z.infer<typeof CountQuery>;
  }): AsyncGenerator<z.infer<typeof Tick>> {
    for (let n = 1; n <= input.query.to; n++) yield {n};
  }

  @get('/denied', {streamOf: Tick})
  // eslint-disable-next-line require-yield
  async *denied(): AsyncGenerator<z.infer<typeof Tick>> {
    throw createError(404, 'no such stream');
  }

  @get('/explodes', {streamOf: Tick})
  async *explodes(): AsyncGenerator<z.infer<typeof Tick>> {
    yield {n: 1};
    throw new Error('boom mid-stream');
  }

  @get('/lies', {streamOf: Tick})
  async *lies(): AsyncGenerator<z.infer<typeof Tick>> {
    yield {n: 1};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yield {n: 'not-a-number'} as any;
    yield {n: 3}; // never sent
  }

  @get('/not-iterable', {streamOf: Tick})
  notIterable(): AsyncGenerator<z.infer<typeof Tick>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return {oops: true} as any;
  }

  @get('/slow', {streamOf: Tick})
  async *slow(): AsyncGenerator<z.infer<typeof Tick>> {
    try {
      for (let n = 1; n <= 1000; n++) {
        yield {n};
        await sleep(20);
      }
    } finally {
      slowCleanedUp = true;
    }
  }
}

/** Read the full body text of an SSE response (stream must terminate). */
async function readAll(res: globalThis.Response): Promise<string> {
  return res.text();
}

/** Split an SSE body into its event frames. */
function frames(text: string): string[] {
  return text.split('\n\n').filter(f => f.trim().length > 0);
}

describe('SSE streaming (integration)', () => {
  let app: RestApplication;
  let base: string;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(StreamController);
    await app.start();
    const server = await app.restServer;
    base = server.url;
  });

  afterAll(async () => {
    await app.stop();
  });

  it('streams validated items as data frames with SSE headers', async () => {
    const res = await fetch(`${base}/sse/count?to=3`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    const fs = frames(await readAll(res));
    expect(fs).toEqual(['data: {"n":1}', 'data: {"n":2}', 'data: {"n":3}']);
  });

  it('validates the input bundle before streaming (400 on bad query)', async () => {
    const res = await fetch(`${base}/sse/count?to=999`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('errors before the first yield keep their HTTP status', async () => {
    const res = await fetch(`${base}/sse/denied`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {error: {message: string}};
    expect(body.error.message).toBe('no such stream');
  });

  it('mid-stream errors become an event: error frame, never a crash', async () => {
    const res = await fetch(`${base}/sse/explodes`);
    expect(res.status).toBe(200);
    const fs = frames(await readAll(res));
    expect(fs[0]).toBe('data: {"n":1}');
    expect(fs[1]).toContain('event: error');
    expect(fs[1]).toContain('Internal Server Error');
    expect(fs[1]).not.toContain('boom mid-stream');
  });

  it('an invalid item terminates the stream with an error frame', async () => {
    const res = await fetch(`${base}/sse/lies`);
    const fs = frames(await readAll(res));
    expect(fs[0]).toBe('data: {"n":1}');
    expect(fs[1]).toContain('event: error');
    expect(fs[1]).toContain('failed response validation');
    expect(fs).toHaveLength(2); // {n:3} never sent
  });

  it('a non-iterable return is a plain 500', async () => {
    const res = await fetch(`${base}/sse/not-iterable`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as {error: {message: string}};
    expect(body.error.message).toBe('Internal Server Error');
  });

  it('client disconnect runs the generator finally block', async () => {
    slowCleanedUp = false;
    const ac = new AbortController();
    const res = await fetch(`${base}/sse/slow`, {signal: ac.signal});
    const reader = res.body!.getReader();
    await reader.read(); // first item arrived; stream is live
    ac.abort();
    // The server sees the close and calls iterator.return() → finally runs.
    await expect
      .poll(() => slowCleanedUp, {timeout: 2000, interval: 25})
      .toBe(true);
  });
});
