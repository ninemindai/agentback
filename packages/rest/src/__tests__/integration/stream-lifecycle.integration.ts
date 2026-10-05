// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import http from 'node:http';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {inject} from '@agentback/context';
import {CoreBindings} from '@agentback/core';
import {AbortReasons} from '@agentback/common';
import {RestApplication} from '../../rest.application.js';
import type {RestServerConfig} from '../../types.js';

const Tick = z.object({n: z.number().int()});
const Chunk = z.object({n: z.number().int(), pad: z.string()});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Big enough that a reader who stops reading fills the transport quickly. */
const CHUNK_BYTES = 256 * 1024;
const CHUNKS = 200;
const PAD = 'x'.repeat(CHUNK_BYTES);

/** What one route's handler observed. */
interface Run {
  /** Items the producer has handed over so far. */
  produced: number;
  /** Set by the generator's `finally`, i.e. when the producer really stops. */
  disposed: boolean;
  signal?: AbortSignal;
}

let runs: Record<string, Run> = {};

function track(route: string, signal?: AbortSignal): Run {
  const run: Run = {produced: 0, disposed: false, signal};
  runs[route] = run;
  return run;
}

async function* ticks(run: Run): AsyncGenerator<z.infer<typeof Tick>> {
  try {
    for (let n = 1; n <= 500; n++) {
      run.produced = n;
      yield {n};
      await sleep(15);
    }
  } finally {
    run.disposed = true;
  }
}

function deferred(): {promise: Promise<void>; resolve: () => void} {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return {promise, resolve};
}

/** Lets the late producer go on; the test decides when. */
let release = deferred();

/**
 * Ignores its abort signal: after the first item it waits for `release`, then
 * yields one more item whether or not the stream is still open.
 */
async function* late(run: Run): AsyncGenerator<z.infer<typeof Tick>> {
  try {
    run.produced = 1;
    yield {n: 1};
    await release.promise;
    run.produced = 2;
    yield {n: 2};
  } finally {
    run.disposed = true;
  }
}

/** As fast as the consumer allows: only backpressure can slow it down. */
async function* chunks(run: Run): AsyncGenerator<z.infer<typeof Chunk>> {
  try {
    for (let n = 1; n <= CHUNKS; n++) {
      run.produced = n;
      yield {n, pad: PAD};
    }
  } finally {
    run.disposed = true;
  }
}

@api({basePath: '/s'})
class StreamController {
  @get('/ticker', {streamOf: Tick})
  ticker(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return ticks(track('ticker', signal));
  }

  @get('/late', {streamOf: Tick})
  late(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return late(track('late', signal));
  }

  @get('/chunks', {streamOf: Chunk})
  chunks(): AsyncGenerator<z.infer<typeof Chunk>> {
    return chunks(track('chunks'));
  }

  @get('/rchunks', {streamOf: Chunk, resumable: {maxEvents: 5}})
  rchunks(): AsyncGenerator<z.infer<typeof Chunk>> {
    return chunks(track('rchunks'));
  }
}

let app: RestApplication | undefined;

async function boot(cfg: RestServerConfig): Promise<string> {
  app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1', ...cfg});
  app.restController(StreamController);
  await app.start();
  return (await app.restServer).url;
}

beforeEach(() => {
  runs = {};
  release = deferred();
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

/**
 * Open a stream with a raw Node client that does NOT read the body: nothing
 * consumes it, so Node stops pulling from the socket and TCP fills up — a
 * slow reader, which is the case backpressure exists for.
 */
function openUnread(
  url: string,
): Promise<{res: http.IncomingMessage; req: http.ClientRequest}> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {agent: false}, res => resolve({res, req}));
    req.on('error', reject);
  });
}

/** Consume a paused response to the end, counting SSE `data:` frames. */
function readAll(res: http.IncomingMessage): Promise<number> {
  return new Promise((resolve, reject) => {
    let frames = 0;
    let tail = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      const text = tail + chunk;
      const parts = text.split('\n\n');
      tail = parts.pop()!;
      for (const p of parts) if (p.includes('data: ')) frames++;
    });
    res.on('end', () => resolve(frames));
    res.on('error', reject);
  });
}

/** Poll until `check` passes or the budget runs out. */
async function waitFor(check: () => boolean, budgetMs = 5000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) await sleep(10);
}

/** Read a body to its end (or until it goes quiet) as text. */
async function readText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const r = await Promise.race([
      reader.read().catch(() => ({done: true, value: undefined})),
      sleep(1000).then(() => undefined),
    ]);
    if (!r || r.done) return text;
    text += decoder.decode(r.value, {stream: true});
  }
}

/**
 * Run `body` and return what reached the process as an uncaught exception
 * meanwhile, including anything Node raises on the next tick after it.
 */
async function uncaughtDuring(body: () => Promise<void>): Promise<Error[]> {
  const errors: Error[] = [];
  const onError = (err: Error) => errors.push(err);
  process.on('uncaughtException', onError);
  try {
    await body();
    await new Promise(r => setImmediate(r));
  } finally {
    process.off('uncaughtException', onError);
  }
  return errors;
}

// Same three hosts as the other streaming suites: backpressure and shutdown are
// promises of the framework, not of one pipeline.
const HOSTS: Array<[string, RestServerConfig]> = [
  ['express dispatch', {}],
  ['web dispatch', {dispatch: 'web'}],
  ['native listener', {listener: 'native'}],
];

describe.each(HOSTS)('stream lifecycle — %s', (_name, cfg) => {
  it('ends a connected plain stream and cancels its producer on stop()', async () => {
    const base = await boot(cfg);
    const res = await fetch(`${base}/s/ticker`);
    const reader = res.body!.getReader();
    await reader.read();

    const stopped = await Promise.race([
      app!.stop().then(() => 'stopped'),
      sleep(2000).then(() => 'hung'),
    ]);
    app = undefined;
    expect(stopped).toBe('stopped');

    // The client sees the end of the stream rather than a dead connection.
    let eof = false;
    for (;;) {
      const r = await Promise.race([
        reader.read().catch(() => ({done: true, value: undefined})),
        sleep(1000).then(() => undefined),
      ]);
      if (!r) break;
      if (r.done) {
        eof = true;
        break;
      }
    }
    expect(eof).toBe(true);
    expect(runs.ticker!.signal!.aborted).toBe(true);
    expect((runs.ticker!.signal!.reason as Error).message).toBe(
      AbortReasons.CANCELLED,
    );
  });

  it('drops an item the producer yields after stop() ended its stream', async () => {
    const base = await boot(cfg);
    const res = await fetch(`${base}/s/late`);
    const reader = res.body!.getReader();
    await reader.read();
    // The producer ignores its signal; the test uses the abort only as the
    // moment stop() ends the stream, and lets the late item go right then.
    runs.late!.signal!.addEventListener('abort', release.resolve);

    let text = '';
    const errors = await uncaughtDuring(async () => {
      await app!.stop();
      app = undefined;
      text = await readText(reader);
      await waitFor(() => runs.late!.disposed);
    });

    expect(errors).toEqual([]);
    expect(runs.late!.produced).toBe(2);
    expect(text).not.toContain('"n":2');
    expect(runs.late!.disposed).toBe(true);
  });

  it('drops an item the producer yields after its client disconnected', async () => {
    const base = await boot(cfg);
    const ac = new AbortController();
    const res = await fetch(`${base}/s/late`, {signal: ac.signal});
    const reader = res.body!.getReader();
    await reader.read();
    runs.late!.signal!.addEventListener('abort', release.resolve);

    const errors = await uncaughtDuring(async () => {
      ac.abort();
      await waitFor(() => runs.late!.disposed);
    });

    expect(errors).toEqual([]);
    expect(runs.late!.produced).toBe(2);
    expect(runs.late!.disposed).toBe(true);
  });

  it('pauses a plain producer while its reader is not reading, then finishes', async () => {
    const base = await boot(cfg);
    const {res} = await openUnread(`${base}/s/chunks`);

    await sleep(800);
    const whilePaused = runs.chunks!.produced;
    // Without backpressure every chunk is produced and buffered at once.
    expect(whilePaused).toBeLessThan(CHUNKS / 2);

    // A reader that comes back gets everything: pausing is not dropping.
    expect(await readAll(res)).toBe(CHUNKS);
    expect(runs.chunks!.produced).toBe(CHUNKS);
  });

  it('pauses a resumable producer while its attached reader is not reading', async () => {
    const base = await boot(cfg);
    const {res} = await openUnread(`${base}/s/rchunks`);

    await sleep(800);
    expect(runs.rchunks!.produced).toBeLessThan(CHUNKS / 2);

    expect(await readAll(res)).toBe(CHUNKS);
  });

  it('a slow reader that disconnects releases the resumable producer into its ring', async () => {
    const base = await boot(cfg);
    const {res, req} = await openUnread(`${base}/s/rchunks`);
    await sleep(800);
    const whilePaused = runs.rchunks!.produced;
    expect(whilePaused).toBeLessThan(CHUNKS / 2);

    // Detached, nobody is being written to: the pump runs on into the ring
    // (bounded by maxEvents) so a later resume still has the tail.
    req.destroy();
    res.destroy();
    await waitFor(() => runs.rchunks!.produced === CHUNKS);
    expect(runs.rchunks!.produced).toBe(CHUNKS);
  });
});
