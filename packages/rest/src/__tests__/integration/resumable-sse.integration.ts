// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {inject} from '@agentback/context';
import {CoreBindings} from '@agentback/core';
import {AbortReasons} from '@agentback/common';
import {securityId, type UserProfile} from '@agentback/security';
import {
  API_KEY_VERIFIER,
  ApiKeyAuthenticationStrategy,
  AuthenticationBindings,
  authenticate,
  type ApiKeyVerifier,
} from '@agentback/authentication';
import {RestApplication} from '../../rest.application.js';
import {REST_DISPATCH_HOOK_TAG, type RestDispatchHook} from '../../keys.js';
import type {RestServerConfig} from '../../types.js';

const Tick = z.object({n: z.number().int()});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What one route's handler observed. */
interface Run {
  /** Proof the handler ran once across a disconnect + resume. */
  invocations: number;
  /** Set by the generator's `finally`, i.e. when the producer really stops. */
  disposed: boolean;
  signal?: AbortSignal;
}

/** Per-route observations, replaced before every test. */
let runs: Record<string, Run> = {};

function track(route: string, signal?: AbortSignal): Run {
  const run = (runs[route] ??= {invocations: 0, disposed: false});
  run.invocations++;
  run.disposed = false;
  run.signal = signal;
  return run;
}

/** `count` ticks 15ms apart, so a test can interrupt it. */
async function* ticks(
  run: Run,
  count = 500,
  firstDelayMs = 0,
): AsyncGenerator<z.infer<typeof Tick>> {
  try {
    if (firstDelayMs) await sleep(firstDelayMs);
    for (let n = 1; n <= count; n++) {
      yield {n};
      await sleep(15);
    }
  } finally {
    run.disposed = true;
  }
}

@api({basePath: '/rs'})
class ResumableController {
  @get('/ticker', {streamOf: Tick, resumable: {windowMs: 5_000, maxEvents: 50}})
  ticker(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return ticks(track('ticker', signal));
  }

  /** Window closes almost immediately: proves an abandoned stream is reaped. */
  @get('/brief', {streamOf: Tick, resumable: {windowMs: 60}})
  brief(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return ticks(track('brief', signal));
  }

  /** Ring of 2: a client away for longer than that cannot be resumed. */
  @get('/tiny', {streamOf: Tick, resumable: {windowMs: 5_000, maxEvents: 2}})
  tiny(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return ticks(track('tiny', signal));
  }

  /** Thinks for 300ms before its first item. */
  @get('/slow', {streamOf: Tick, resumable: {windowMs: 100}})
  slow(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return ticks(track('slow', signal), 500, 300);
  }

  /** Three items, then done. */
  @get('/finite', {streamOf: Tick, resumable: {windowMs: 5_000}})
  finite(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return ticks(track('finite', signal), 3);
  }

  @get('/secure', {streamOf: Tick, resumable: {windowMs: 5_000}})
  @authenticate('api-key')
  secure(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ): AsyncGenerator<z.infer<typeof Tick>> {
    return ticks(track('secure', signal));
  }
}

const KEYS: Record<string, UserProfile> = {
  'alice-key': {[securityId]: 'alice'},
  'bob-key': {[securityId]: 'bob'},
};
const verifier: ApiKeyVerifier = key => KEYS[key];

/** A header-contributing hook, like the x402 price gate. */
const headerHook: RestDispatchHook = async (info, next) => {
  info.responseHeaders.set('x-hook', 'seen');
  return next();
};

let app: RestApplication | undefined;

async function boot(
  cfg: RestServerConfig,
  opts: {hook?: boolean} = {},
): Promise<string> {
  app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1', ...cfg});
  app.restController(ResumableController);
  app.bind(API_KEY_VERIFIER).to(verifier);
  app
    .bind('strategies.apiKey')
    .toClass(ApiKeyAuthenticationStrategy)
    .tag(AuthenticationBindings.AUTH_STRATEGY);
  if (opts.hook) {
    app.bind('hooks.header').to(headerHook).tag(REST_DISPATCH_HOOK_TAG);
  }
  await app.start();
  return (await app.restServer).url;
}

beforeEach(() => {
  runs = {};
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

/** Open a stream; aborting `ac` drops the socket, like a browser refresh. */
async function open(
  url: string,
  headers: Record<string, string> = {},
): Promise<{res: globalThis.Response; ac: AbortController}> {
  const ac = new AbortController();
  const res = await fetch(url, {signal: ac.signal, headers});
  return {res, ac};
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

/** Poll until `check` passes or the budget runs out. */
async function waitFor(check: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) await sleep(10);
}

/** The refusal every unusable `Last-Event-ID` gets, whatever the cause. */
async function expectRefused(res: globalThis.Response): Promise<unknown> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as {error: {code: string}};
  expect(body.error).toMatchObject({statusCode: 409, code: 'conflict'});
  return body;
}

// Same three hosts as abort.integration.ts: a resumable stream is a promise of
// the framework, not of one pipeline.
const HOSTS: Array<[string, RestServerConfig]> = [
  ['express dispatch', {}],
  ['web dispatch', {dispatch: 'web'}],
  ['native listener', {listener: 'native'}],
];

describe.each(HOSTS)('resumable SSE — %s', (_name, cfg) => {
  it('puts an id on every frame so EventSource can resume unaided', async () => {
    const base = await boot(cfg);
    const {res, ac} = await open(`${base}/rs/ticker`);
    const got = await readUntil(res, ac, f => f.length >= 2);
    expect(got[0]).toMatch(/^id: [0-9a-f-]{36}\.1\ndata: \{"n":1\}$/);
    expect(got[1]).toMatch(/\.2\ndata: \{"n":2\}$/);
  });

  it('survives a disconnect and replays the gap without re-running the handler', async () => {
    const base = await boot(cfg);
    const first = await open(`${base}/rs/ticker`);
    const seen = await readUntil(first.res, first.ac, f => f.length >= 3);
    expect(runs.ticker!.invocations).toBe(1);
    const resumeFrom = lastId(seen);
    const lastSeen = seqOf(seen[seen.length - 1]!);

    // Stay away long enough that the producer must have moved on alone.
    await sleep(120);

    const second = await open(`${base}/rs/ticker`, {
      'Last-Event-ID': resumeFrom,
    });
    expect(second.res.status).toBe(200);
    const more = await readUntil(second.res, second.ac, f => f.length >= 4);

    // The handler was NOT invoked again: this is the same producer.
    expect(runs.ticker!.invocations).toBe(1);
    // No gap and no repeat: the next frame is exactly the one after the last
    // frame the client actually saw.
    expect(seqOf(more[0]!)).toBe(lastSeen + 1);
    // And it caught up past where the client left off, proving the producer
    // kept working while nobody was reading.
    expect(seqOf(more[more.length - 1]!)).toBeGreaterThan(lastSeen + 1);
  });

  it('disposes the producer when the resume window closes', async () => {
    const base = await boot(cfg);
    const {res, ac} = await open(`${base}/rs/brief`);
    await readUntil(res, ac, f => f.length >= 2);
    expect(runs.brief!.disposed).toBe(false); // still running: the whole point

    await waitFor(() => runs.brief!.disposed, 1000); // 60ms window + slack
    expect(runs.brief!.disposed).toBe(true);
    expect((runs.brief!.signal!.reason as Error).message).toBe(
      AbortReasons.RESUME_WINDOW_CLOSED,
    );
  });

  it('gives the producer an abort signal tied to the stream, not the socket', async () => {
    const base = await boot(cfg);
    const {res, ac} = await open(`${base}/rs/ticker`);
    await readUntil(res, ac, f => f.length >= 2);
    // The socket is gone but the signal must NOT have fired — that is the
    // deliberate inversion of the normal client-disconnect abort.
    await sleep(60);
    expect(runs.ticker!.signal!.aborted).toBe(false);
  });

  it('does not abort the signal of a stream that completed normally', async () => {
    const base = await boot(cfg);
    const res = await fetch(`${base}/rs/finite`);
    const text = await res.text(); // runs to EOF
    expect(text).toContain('data: {"n":3}');
    await sleep(50);
    expect(runs.finite!.signal!.aborted).toBe(false);
  });

  it('answers an unsatisfiable resume with 409, without re-running the handler', async () => {
    const base = await boot(cfg);
    const {res, ac} = await open(`${base}/rs/tiny`);
    const stale = lastId(await readUntil(res, ac, f => f.length >= 1));

    // maxEvents is 2, so waiting lets the ring discard our position entirely.
    await sleep(200);

    await expectRefused(
      await fetch(`${base}/rs/tiny`, {headers: {'Last-Event-ID': stale}}),
    );
    expect(runs.tiny!.invocations).toBe(1);
  });

  it('answers an expired stream id with 409, never a fresh run', async () => {
    const base = await boot(cfg);
    const {res, ac} = await open(`${base}/rs/brief`);
    const id = lastId(await readUntil(res, ac, f => f.length >= 1));
    await waitFor(() => runs.brief!.disposed, 1000);

    await expectRefused(
      await fetch(`${base}/rs/brief`, {headers: {'Last-Event-ID': id}}),
    );
    // EventSource stops on a non-200; a re-run here would be the duplicate
    // agent turn `resumable:` exists to prevent.
    expect(runs.brief!.invocations).toBe(1);
  });

  it('refuses a stream id presented on another route, like an unknown one', async () => {
    const base = await boot(cfg);
    const {res, ac} = await open(`${base}/rs/ticker`);
    const id = lastId(await readUntil(res, ac, f => f.length >= 1));

    const crossRoute = await expectRefused(
      await fetch(`${base}/rs/tiny`, {headers: {'Last-Event-ID': id}}),
    );
    const unknown = await expectRefused(
      await fetch(`${base}/rs/tiny`, {
        headers: {'Last-Event-ID': `${crypto.randomUUID()}.1`},
      }),
    );
    expect(crossRoute).toEqual(unknown);
    expect(runs.tiny).toBeUndefined(); // never invoked
  });

  it('refuses a resume by a different principal, like an unknown one', async () => {
    const base = await boot(cfg);
    const {res, ac} = await open(`${base}/rs/secure`, {
      'x-api-key': 'alice-key',
    });
    const id = lastId(await readUntil(res, ac, f => f.length >= 1));

    const foreign = await expectRefused(
      await fetch(`${base}/rs/secure`, {
        headers: {'x-api-key': 'bob-key', 'Last-Event-ID': id},
      }),
    );
    const unknown = await expectRefused(
      await fetch(`${base}/rs/secure`, {
        headers: {
          'x-api-key': 'bob-key',
          'Last-Event-ID': `${crypto.randomUUID()}.1`,
        },
      }),
    );
    expect(foreign).toEqual(unknown);

    // The owner still can.
    const own = await open(`${base}/rs/secure`, {
      'x-api-key': 'alice-key',
      'Last-Event-ID': id,
    });
    expect(own.res.status).toBe(200);
    await readUntil(own.res, own.ac, f => f.length >= 1);
    expect(runs.secure!.invocations).toBe(1);
  });

  it('keeps feeding the new connection when the replaced one closes late', async () => {
    const base = await boot(cfg);
    const a = await open(`${base}/rs/ticker`);
    const readerA = a.res.body!.getReader();
    const first = new TextDecoder().decode((await readerA.read()).value);
    const id = first.split('\n')[0]!.slice('id: '.length);

    // B resumes while A is still connected; then A's close lands.
    const b = await open(`${base}/rs/ticker`, {'Last-Event-ID': id});
    const readerB = b.res.body!.getReader();
    await readerB.read();
    a.ac.abort();
    await sleep(100);

    let bytes = 0;
    const until = Date.now() + 300;
    while (Date.now() < until) {
      const r = await Promise.race([
        readerB.read(),
        sleep(300).then(() => ({done: true, value: undefined})),
      ]);
      if (r.done) break;
      bytes += r.value!.length;
    }
    expect(bytes).toBeGreaterThan(0);
    expect(runs.ticker!.disposed).toBe(false);
    expect(runs.ticker!.invocations).toBe(1);
    b.ac.abort();
  });

  it('starts the window for a client that left before the first item', async () => {
    const base = await boot(cfg);
    const ac = new AbortController();
    const inflight = fetch(`${base}/rs/slow`, {signal: ac.signal}).catch(
      () => undefined,
    );
    await waitFor(() => runs.slow !== undefined);
    await sleep(50);
    ac.abort(); // the first item is still 250ms away
    await inflight;

    // 300ms to the first item + the 100ms window + slack.
    await waitFor(() => runs.slow!.disposed, 2000);
    expect(runs.slow!.disposed).toBe(true);
    expect((runs.slow!.signal!.reason as Error).message).toBe(
      AbortReasons.RESUME_WINDOW_CLOSED,
    );
  });

  it('resumes through a dispatch hook that contributes a response header', async () => {
    const base = await boot(cfg, {hook: true});
    const first = await open(`${base}/rs/ticker`);
    expect(first.res.headers.get('x-hook')).toBe('seen');
    const id = lastId(await readUntil(first.res, first.ac, f => f.length >= 2));

    const second = await open(`${base}/rs/ticker`, {'Last-Event-ID': id});
    expect(second.res.status).toBe(200);
    expect(second.res.headers.get('x-hook')).toBe('seen');
    const more = await readUntil(second.res, second.ac, f => f.length >= 2);
    expect(seqOf(more[0]!)).toBe(3);
    expect(runs.ticker!.invocations).toBe(1);
  });

  it('ends connected streams and cancels their producers on stop()', async () => {
    const base = await boot(cfg);
    const {res} = await open(`${base}/rs/ticker`);
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
    expect((runs.ticker!.signal!.reason as Error).message).toBe(
      AbortReasons.CANCELLED,
    );
  });

  it('refuses a new stream with 503 + Retry-After when the server is full', async () => {
    const base = await boot({...cfg, resumable: {maxLiveStreams: 2}});
    const a = await open(`${base}/rs/ticker`);
    const idA = lastId(await readUntil(a.res, a.ac, f => f.length >= 1));
    const b = await open(`${base}/rs/brief`);
    const readerB = b.res.body!.getReader();
    await readerB.read();

    const full = await fetch(`${base}/rs/ticker`);
    expect(full.status).toBe(503);
    expect(Number(full.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await full.json()) as {error: unknown};
    expect(body.error).toMatchObject({statusCode: 503, retryable: true});
    expect(runs.ticker!.invocations).toBe(1); // the handler never ran

    // A resume is not a new stream: it is admitted while full.
    const again = await open(`${base}/rs/ticker`, {'Last-Event-ID': idA});
    expect(again.res.status).toBe(200);
    await readUntil(again.res, again.ac, f => f.length >= 1);

    // Once a stream is gone, its slot is free again.
    b.ac.abort();
    await waitFor(() => runs.brief!.disposed, 1000);
    await sleep(20);
    const next = await open(`${base}/rs/ticker`);
    expect(next.res.status).toBe(200);
    await readUntil(next.res, next.ac, f => f.length >= 1);
    expect(runs.ticker!.invocations).toBe(2);
  });
});
