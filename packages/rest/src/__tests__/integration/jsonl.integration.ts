// Copyright Ninemind.ai 2026. All Rights Reserved.
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

@api({basePath: '/jsonl'})
class JsonlStreamController {
  @get('/count', {query: CountQuery, streamOf: Tick, format: 'jsonl'})
  async *count(input: {
    query: z.infer<typeof CountQuery>;
  }): AsyncGenerator<z.infer<typeof Tick>> {
    for (let n = 1; n <= input.query.to; n++) yield {n};
  }

  @get('/denied', {streamOf: Tick, format: 'jsonl'})
  async *denied(): AsyncGenerator<z.infer<typeof Tick>> {
    throw createError(404, 'no such stream');
  }

  @get('/explodes', {streamOf: Tick, format: 'jsonl'})
  async *explodes(): AsyncGenerator<z.infer<typeof Tick>> {
    yield {n: 1};
    throw new Error('boom mid-stream');
  }

  @get('/lies', {streamOf: Tick, format: 'jsonl'})
  async *lies(): AsyncGenerator<z.infer<typeof Tick>> {
    yield {n: 1};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    yield {n: 'not-a-number'} as any;
    yield {n: 3}; // never sent
  }

  @get('/slow', {streamOf: Tick, format: 'jsonl'})
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

/** Split an NDJSON body into its non-blank lines. */
function lines(text: string): string[] {
  return text.split('\n').filter(l => l.trim().length > 0);
}

describe('JSONL streaming (integration)', () => {
  let app: RestApplication;
  let base: string;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(JsonlStreamController);
    await app.start();
    const server = await app.restServer;
    base = server.url;
  });

  afterAll(async () => {
    await app.stop();
  });

  it('streams validated items as NDJSON lines with application/jsonl', async () => {
    const res = await fetch(`${base}/jsonl/count?to=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/jsonl');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    const text = await res.text();
    expect(text).toBe('{"n":1}\n{"n":2}\n');
    expect(lines(text)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('validates the input bundle before streaming (400 on bad query)', async () => {
    const res = await fetch(`${base}/jsonl/count?to=999`);
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('errors before the first yield keep their HTTP status', async () => {
    const res = await fetch(`${base}/jsonl/denied`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {error: {message: string}};
    expect(body.error.message).toBe('no such stream');
  });

  it('mid-stream errors become a trailing error line, never a crash', async () => {
    const res = await fetch(`${base}/jsonl/explodes`);
    expect(res.status).toBe(200);
    const ls = lines(await res.text());
    expect(ls[0]).toBe('{"n":1}');
    const last = JSON.parse(ls[1]) as {error: {message: string}};
    expect(last.error.message).toBe('Internal Server Error');
    expect(JSON.stringify(last)).not.toContain('boom mid-stream');
  });

  it('an invalid item terminates the stream with an error line', async () => {
    const res = await fetch(`${base}/jsonl/lies`);
    const ls = lines(await res.text());
    expect(ls[0]).toBe('{"n":1}');
    const last = JSON.parse(ls[1]) as {error: {message: string}};
    expect(last.error.message).toContain('failed response validation');
    expect(ls).toHaveLength(2); // {n:3} never sent
  });

  it('client disconnect runs the generator finally block', async () => {
    slowCleanedUp = false;
    const ac = new AbortController();
    const res = await fetch(`${base}/jsonl/slow`, {signal: ac.signal});
    const reader = res.body!.getReader();
    await reader.read(); // first item arrived; stream is live
    ac.abort();
    await expect
      .poll(() => slowCleanedUp, {timeout: 2000, interval: 25})
      .toBe(true);
  });
});
