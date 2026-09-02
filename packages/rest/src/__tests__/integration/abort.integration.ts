// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {api, get} from '@agentback/openapi';
import {inject} from '@agentback/context';
import {CoreBindings} from '@agentback/core';
import {AbortReasons} from '@agentback/common';
import {RestApplication} from '../../rest.application.js';
import type {RestServerConfig} from '../../types.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What the in-flight handler observed, reset per test. */
let seen: {signal?: AbortSignal; reason?: unknown} = {};

@api({basePath: '/abort'})
class SlowController {
  /**
   * Blocks until its injected signal aborts (or a 3s safety net fires, which
   * would make the assertions below fail rather than hang the suite).
   */
  @get('/slow')
  async slow(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true})
    signal?: AbortSignal,
  ): Promise<{done: boolean}> {
    seen = {signal};
    await new Promise<void>(resolve => {
      const safety = setTimeout(resolve, 3000);
      const stop = () => {
        clearTimeout(safety);
        resolve();
      };
      if (!signal) return;
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, {once: true});
    });
    seen.reason = signal?.reason;
    return {done: true};
  }

  /** Returns at once — used to prove a normal finish is not an abort. */
  @get('/quick')
  async quick(
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true})
    signal?: AbortSignal,
  ): Promise<{done: boolean}> {
    seen = {signal};
    return {done: true};
  }
}

/** Poll until `check` passes or the budget runs out. */
async function waitFor(check: () => boolean, budgetMs = 2000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check() && Date.now() < deadline) await sleep(10);
}

let app: RestApplication | undefined;

async function boot(cfg: RestServerConfig): Promise<string> {
  seen = {};
  app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1', ...cfg});
  app.restController(SlowController);
  await app.start();
  return (await app.restServer).url;
}

afterEach(async () => {
  await app?.stop();
  app = undefined;
});

// The three hosts that can serve an `@api` route. A per-request abort signal
// is a promise of the framework, not of one pipeline, so all three must keep
// it — the Express path, the Web pipeline mounted on Express, and the native
// fetch listener where there is no Express at all.
const HOSTS: Array<[string, RestServerConfig]> = [
  ['express dispatch', {}],
  ['web dispatch', {dispatch: 'web'}],
  ['native listener', {listener: 'native'}],
];

describe.each(HOSTS)('request abort signal — %s', (_name, cfg) => {
  it('is bound into the request context', async () => {
    const base = await boot(cfg);
    const ac = new AbortController();
    const inflight = fetch(`${base}/abort/slow`, {signal: ac.signal}).catch(
      () => undefined,
    );
    await waitFor(() => seen.signal !== undefined);
    expect(seen.signal).toBeInstanceOf(AbortSignal);
    expect(seen.signal!.aborted).toBe(false);
    ac.abort();
    await inflight;
  });

  it('aborts when the caller disconnects, with a readable reason', async () => {
    const base = await boot(cfg);
    const ac = new AbortController();
    const inflight = fetch(`${base}/abort/slow`, {signal: ac.signal}).catch(
      () => undefined,
    );
    await waitFor(() => seen.signal !== undefined);
    ac.abort();
    await inflight;

    await waitFor(() => seen.reason !== undefined);
    expect(seen.signal!.aborted).toBe(true);
    expect((seen.reason as DOMException).name).toBe('AbortError');
    expect((seen.reason as DOMException).message).toBe(
      AbortReasons.CALLER_GONE,
    );
  });

  it('does not abort a request that completed normally', async () => {
    const base = await boot(cfg);
    const res = await fetch(`${base}/abort/quick`);
    expect(res.status).toBe(200);
    await res.json();

    // The response closing because it FINISHED is not a disconnect. A handler
    // that hands the signal to background work must not have it yanked the
    // moment it returns, so give the close event a tick to land and re-check.
    await sleep(50);
    expect(seen.signal!.aborted).toBe(false);
  });
});
