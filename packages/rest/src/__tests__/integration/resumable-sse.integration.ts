// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {inject} from '@agentback/context';
import {CoreBindings} from '@agentback/core';
import {RestApplication} from '../../rest.application.js';

const Tick = z.object({n: z.number().int()});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Proof the handler ran once across a disconnect + resume. */
let invocations = 0;
/** Set by the ticker's `finally`, i.e. when the producer is really disposed. */
let disposed = false;
/** Abort reason the producer observed, if any. */
let abortReason: string | undefined;

@api({basePath: '/rs'})
class ResumableController {
  /** Emits forever until disposed; 15ms apart so a test can interrupt it. */
  @get('/ticker', {streamOf: Tick, resumable: {windowMs: 5_000, maxEvents: 50}})
  async *ticker(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true})
    signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    invocations++;
    disposed = false;
    abortReason = undefined;
    signal?.addEventListener('abort', () => {
      abortReason = (signal.reason as Error | undefined)?.message;
    });
    try {
      for (let n = 1; n <= 500; n++) {
        yield {n};
        await sleep(15);
      }
    } finally {
      disposed = true;
    }
  }

  /** Window closes almost immediately: proves an abandoned stream is reaped. */
  @get('/brief', {streamOf: Tick, resumable: {windowMs: 60}})
  async *brief(): AsyncGenerator<z.infer<typeof Tick>> {
    try {
      for (let n = 1; n <= 500; n++) {
        yield {n};
        await sleep(15);
      }
    } finally {
      disposed = true;
    }
  }

  /** Ring of 2: a client away for longer than that cannot be resumed. */
  @get('/tiny', {streamOf: Tick, resumable: {windowMs: 5_000, maxEvents: 2}})
  async *tiny(): AsyncGenerator<z.infer<typeof Tick>> {
    for (let n = 1; n <= 500; n++) {
      yield {n};
      await sleep(15);
    }
  }
}

/**
 * Read SSE frames until `stop` says enough, then abandon the socket — which is
 * what a browser refresh looks like to the server.
 */
async function readUntil(
  res: globalThis.Response,
  controller: AbortController,
  stop: (frames: string[]) => boolean,
): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: string[] = [];
  let buf = '';
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    const parts = buf.split('\n\n');
    buf = parts.pop()!;
    for (const p of parts) if (p.trim()) out.push(p);
    if (stop(out)) {
      controller.abort();
      break;
    }
  }
  return out;
}

/** `id: <streamId>.<seq>` → the raw id, for the `Last-Event-ID` header. */
function lastId(frames: string[]): string {
  const withId = [...frames].reverse().find(f => f.startsWith('id: '));
  return withId!.split('\n')[0]!.slice('id: '.length);
}

function seqOf(frame: string): number {
  return JSON.parse(frame.split('data: ')[1]!).n as number;
}

describe('resumable SSE (integration)', () => {
  let app: RestApplication;
  let base: string;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(ResumableController);
    await app.start();
    base = (await app.restServer).url;
  });

  afterAll(async () => {
    await app.stop();
  });

  it('puts an id on every frame so EventSource can resume unaided', async () => {
    invocations = 0;
    const ac = new AbortController();
    const res = await fetch(`${base}/rs/ticker`, {signal: ac.signal});
    const got = await readUntil(res, ac, f => f.length >= 2);
    expect(got[0]).toMatch(/^id: [0-9a-f-]{36}\.1\ndata: \{"n":1\}$/);
    expect(got[1]).toMatch(/\.2\ndata: \{"n":2\}$/);
  });

  it('survives a disconnect and replays the gap without re-running the handler', async () => {
    invocations = 0;
    const ac = new AbortController();
    const first = await fetch(`${base}/rs/ticker`, {signal: ac.signal});
    const seen = await readUntil(first, ac, f => f.length >= 3);
    expect(invocations).toBe(1);
    const resumeFrom = lastId(seen);
    const lastSeen = seqOf(seen[seen.length - 1]!);

    // Stay away long enough that the producer must have moved on alone.
    await sleep(120);

    const ac2 = new AbortController();
    const second = await fetch(`${base}/rs/ticker`, {
      signal: ac2.signal,
      headers: {'Last-Event-ID': resumeFrom},
    });
    const more = await readUntil(second, ac2, f => f.length >= 4);

    // The handler was NOT invoked again: this is the same producer.
    expect(invocations).toBe(1);
    // No gap and no repeat: the next frame is exactly the one after the last
    // frame the client actually saw.
    expect(seqOf(more[0]!)).toBe(lastSeen + 1);
    // And it caught up past where the client left off, proving the producer
    // kept working while nobody was reading.
    expect(seqOf(more[more.length - 1]!)).toBeGreaterThan(lastSeen + 1);
  });

  it('disposes the producer when the resume window closes', async () => {
    disposed = false;
    const ac = new AbortController();
    const res = await fetch(`${base}/rs/brief`, {signal: ac.signal});
    await readUntil(res, ac, f => f.length >= 2);
    expect(disposed).toBe(false); // still running: this is option A's whole point

    await sleep(300); // 60ms window + slack
    expect(disposed).toBe(true);
  });

  it('gives the producer an abort signal tied to the stream, not the socket', async () => {
    invocations = 0;
    const ac = new AbortController();
    const res = await fetch(`${base}/rs/ticker`, {signal: ac.signal});
    await readUntil(res, ac, f => f.length >= 2);
    // The socket is gone but the signal must NOT have fired — that is the
    // deliberate inversion of the normal client-disconnect abort.
    await sleep(60);
    expect(abortReason).toBeUndefined();
  });

  it('refuses an unsatisfiable resume instead of silently skipping events', async () => {
    const ac = new AbortController();
    const res = await fetch(`${base}/rs/tiny`, {signal: ac.signal});
    const seen = await readUntil(res, ac, f => f.length >= 1);
    const stale = lastId(seen);

    // maxEvents is 2, so waiting lets the ring discard our position entirely.
    await sleep(200);

    const res2 = await fetch(`${base}/rs/tiny`, {
      headers: {'Last-Event-ID': stale},
    });
    const body = await res2.text();
    expect(body).toContain('event: error');
    expect(body).toContain('Cannot resume');
  });
});
