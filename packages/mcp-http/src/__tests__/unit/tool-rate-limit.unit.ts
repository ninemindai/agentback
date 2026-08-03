// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import type {Request, Response} from 'express';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {
  createToolRateLimiter,
  toolRateLimitMiddleware,
} from '../../tool-rate-limit.js';

interface RunResult {
  nextCalled: boolean;
  status?: number;
  body?: {jsonrpc?: string; error?: {code?: number}; id?: unknown};
  headers: Record<string, string>;
}

function run(
  mw: ReturnType<typeof toolRateLimitMiddleware>,
  body: unknown,
): Promise<RunResult> {
  return new Promise(resolve => {
    const headers: Record<string, string> = {};
    let status: number | undefined;
    const res = {
      set(k: string, v: string) {
        headers[k] = String(v);
        return res;
      },
      status(c: number) {
        status = c;
        return res;
      },
      json(b: unknown) {
        resolve({
          nextCalled: false,
          status,
          body: b as RunResult['body'],
          headers,
        });
        return res;
      },
    } as unknown as Response;
    const req = {body, ip: '1.2.3.4'} as unknown as Request;
    mw(req, res, () => resolve({nextCalled: true, status, headers}));
  });
}

const call = (name: string, id = 1) => ({
  jsonrpc: '2.0',
  method: 'tools/call',
  params: {name},
  id,
});

describe('toolRateLimitMiddleware', () => {
  it('limits a tool per caller, then 429s with a JSON-RPC error', async () => {
    const mw = toolRateLimitMiddleware({
      points: 2,
      durationSecs: 60,
      keyGenerator: () => 'c1',
    });
    expect((await run(mw, call('t'))).nextCalled).toBe(true);
    expect((await run(mw, call('t'))).nextCalled).toBe(true);
    const r3 = await run(mw, call('t', 7));
    expect(r3.status).toBe(429);
    expect(r3.body?.jsonrpc).toBe('2.0');
    expect(r3.body?.error?.code).toBe(-32029);
    expect(r3.body?.id).toBe(7);
    expect(r3.headers['Retry-After']).toBeDefined();
  });

  it('gives each tool its own bucket', async () => {
    const mw = toolRateLimitMiddleware({points: 1, keyGenerator: () => 'c'});
    expect((await run(mw, call('a'))).nextCalled).toBe(true);
    expect((await run(mw, call('b'))).nextCalled).toBe(true); // different tool
    expect((await run(mw, call('a'))).status).toBe(429); // 'a' exhausted
  });

  it('applies per-tool overrides', async () => {
    const mw = toolRateLimitMiddleware({
      points: 5,
      perTool: {strict: {points: 1}},
      keyGenerator: () => 'c',
    });
    expect((await run(mw, call('strict'))).nextCalled).toBe(true);
    expect((await run(mw, call('strict'))).status).toBe(429); // override = 1
    expect((await run(mw, call('loose'))).nextCalled).toBe(true); // default = 5
  });

  it('ignores non-tools/call methods', async () => {
    const mw = toolRateLimitMiddleware({points: 1, keyGenerator: () => 'c'});
    expect((await run(mw, {method: 'tools/list', id: 1})).nextCalled).toBe(
      true,
    );
    expect((await run(mw, {method: 'tools/list', id: 2})).nextCalled).toBe(
      true,
    );
    expect((await run(mw, {method: 'initialize', id: 3})).nextCalled).toBe(
      true,
    );
  });

  it('counts a batched array, which used to bypass the limit entirely', async () => {
    // A JSON-RPC body may be an ARRAY. 2025-06-18 removed batching from the
    // spec, but the SDK transport still processes one, and the old
    // implementation read `body.method` — `undefined` on an array — and waved
    // it through. Verified against the shipping Express mount before this fix:
    // with points=2, a caller already being answered 429 on single calls got a
    // 200 and five more tool invocations by wrapping them in an array.
    const mw = toolRateLimitMiddleware({
      points: 3,
      keyGenerator: () => 'batch',
    });
    const r = await run(mw, [call('t', 1), call('t', 2), call('t', 3)]);
    expect(r.nextCalled).toBe(true); // exactly at the limit
    const r2 = await run(mw, [call('t', 4)]);
    expect(r2.status).toBe(429); // the batch consumed all 3 points
  });

  it('rejects a batch that exceeds the limit in one request', async () => {
    const mw = toolRateLimitMiddleware({points: 2, keyGenerator: () => 'big'});
    const r = await run(mw, [call('t', 1), call('t', 2), call('t', 3)]);
    expect(r.status).toBe(429);
    // Rejecting the whole batch, not executing part of it: a partially applied
    // batch is worse than a refused one.
    expect(r.body?.id).toBe(1); // the first limited call's id
  });
});

// The neutral core both hosts share. `toolRateLimitMiddleware` is now a thin
// Express wrapper over this; the fetch mount calls it inline, since that host
// has no middleware chain to mount anything into.
describe('createToolRateLimiter (host-neutral core)', () => {
  const caller = (
    over: Partial<
      Parameters<ReturnType<typeof createToolRateLimiter>['check']>[1]
    > = {},
  ) => ({
    header: () => undefined,
    ...over,
  });

  const tc = (name: string, id = 1) => ({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {name},
    id,
  });

  it('buckets per caller key', async () => {
    const limiter = createToolRateLimiter({
      points: 1,
      keyGenerator: c => c.authInfo?.extra?.sub as string,
    });
    const sub = (s: string) =>
      caller({
        authInfo: {
          token: 't',
          clientId: 'shared',
          scopes: [],
          extra: {sub: s},
        } as AuthInfo,
      });

    expect((await limiter.check(tc('t'), sub('alice'))).ok).toBe(true);
    expect((await limiter.check(tc('t'), sub('bob'))).ok).toBe(true);
    expect((await limiter.check(tc('t'), sub('alice'))).ok).toBe(false);
  });

  it('would collide two users under the default clientId key', async () => {
    // Pins the documented hazard. Unlike `cachedPerPrincipal` — where a shared
    // key leaks one user's DATA to another — the cost here is fairness: one
    // noisy user of a popular MCP client starves everyone else using it. Real,
    // but not a confidentiality bug, which is why the default stays and is
    // documented rather than being made required.
    const limiter = createToolRateLimiter({points: 1});
    const shared = (sub: string) =>
      caller({
        authInfo: {
          token: 't',
          clientId: 'acme-web-app',
          scopes: [],
          extra: {sub},
        } as AuthInfo,
      });
    expect((await limiter.check(tc('t'), shared('alice'))).ok).toBe(true);
    expect((await limiter.check(tc('t'), shared('bob'))).ok).toBe(false); // bob pays for alice
  });

  it('exposes headers to the key generator on every host', async () => {
    const limiter = createToolRateLimiter({
      points: 1,
      keyGenerator: c => c.header('X-Api-Key') ?? 'anon',
    });
    const withKey = (k: string) =>
      caller({header: n => (n.toLowerCase() === 'x-api-key' ? k : undefined)});
    expect((await limiter.check(tc('t'), withKey('k1'))).ok).toBe(true);
    expect((await limiter.check(tc('t'), withKey('k2'))).ok).toBe(true);
    expect((await limiter.check(tc('t'), withKey('k1'))).ok).toBe(false);
  });

  it('reports the tool and a retry delay when it says no', async () => {
    const limiter = createToolRateLimiter({
      points: 1,
      durationSecs: 30,
      keyGenerator: () => 'c',
    });
    await limiter.check(tc('slow'), caller());
    const d = await limiter.check(tc('slow', 9), caller());
    expect(d).toMatchObject({ok: false, tool: 'slow', id: 9});
    if (!d.ok) expect(d.retryAfterSecs).toBeGreaterThan(0);
  });

  it('ignores a body with no tools/call in it', async () => {
    const limiter = createToolRateLimiter({points: 1, keyGenerator: () => 'c'});
    for (const body of [
      {method: 'tools/list', id: 1},
      [
        {method: 'tools/list', id: 1},
        {method: 'initialize', id: 2},
      ],
      undefined,
      'not json-rpc',
    ]) {
      expect((await limiter.check(body, caller())).ok).toBe(true);
    }
  });
});

// Branches the /plan-eng-review coverage audit found untested. Each is a
// documented posture, and a posture with no assertion is a comment.
describe('createToolRateLimiter — the branches nobody was testing', () => {
  const tc = (name: string, id = 1) => ({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: {name},
    id,
  });
  const caller = (over: Record<string, unknown> = {}) =>
    ({
      header: () => undefined,
      ...over,
    }) as Parameters<ReturnType<typeof createToolRateLimiter>['check']>[1];

  it('FAILS OPEN when the store itself is broken', async () => {
    // Redis down must not lock every caller out of every tool. This is a
    // deliberate availability-over-enforcement trade, and if a refactor ever
    // flips it to fail-closed, a cache blip becomes a total tool outage.
    const exploding = {
      consume() {
        return Promise.reject(new Error('ECONNREFUSED: redis is down'));
      },
    };
    const limiter = createToolRateLimiter({
      points: 1,
      store: exploding,
      keyGenerator: () => 'c',
    });
    // Well past the limit — still allowed, because the store never answered.
    for (let i = 0; i < 5; i++) {
      expect((await limiter.check(tc('t'), caller())).ok).toBe(true);
    }
  });

  it('keeps a caller blocked for blockSecs after they exceed', async () => {
    const limiter = createToolRateLimiter({
      points: 1,
      durationSecs: 1,
      blockSecs: 60,
      keyGenerator: () => 'blocked',
    });
    expect((await limiter.check(tc('t'), caller())).ok).toBe(true);
    const first = await limiter.check(tc('t'), caller());
    expect(first.ok).toBe(false);
    // The block outlives the 1s window it was earned in.
    if (!first.ok) expect(first.retryAfterSecs).toBeGreaterThan(1);
  });

  it('falls back through ip to a shared anon bucket by default', async () => {
    // No keyGenerator: authInfo wins, then ip, then one shared 'anon' bucket.
    // The fetch host supplies no ip, so edge callers share 'anon' — coarse,
    // but it still says no, which is the point.
    const limiter = createToolRateLimiter({points: 1});
    expect((await limiter.check(tc('t'), caller({ip: '1.1.1.1'}))).ok).toBe(
      true,
    );
    // Different ip => different bucket.
    expect((await limiter.check(tc('t'), caller({ip: '2.2.2.2'}))).ok).toBe(
      true,
    );
    // Same ip again => exhausted.
    expect((await limiter.check(tc('t'), caller({ip: '1.1.1.1'}))).ok).toBe(
      false,
    );
    // No ip at all => the shared anon bucket, independent of the ip ones.
    expect((await limiter.check(tc('t'), caller())).ok).toBe(true);
    expect((await limiter.check(tc('t'), caller())).ok).toBe(false);
  });
});
