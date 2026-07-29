// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it, vi} from 'vitest';
import {Context} from '@agentback/core';
import {MCPBindings} from '@agentback/mcp';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {cachedPerPrincipal} from '../../binder-cache.js';

// Under `protocol: 'stateless'` the binder runs on EVERY request, so an
// entitlement lookup inside it becomes a per-request database query. That
// failure mode is a quiet load multiplier, not an error, which is what these
// tests pin down. Only `lookup` is cached — `apply` must still run per request
// against that request's own context.

const principal = (clientId: string, scopes: string[] = []): AuthInfo => ({
  token: 't',
  clientId,
  scopes,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

/** One request: a fresh child context carrying the principal, as the real seam does. */
function requestCtx(app: Context, auth?: AuthInfo) {
  const ctx = new Context(app, 'mcp.session');
  if (auth) ctx.bind(MCPBindings.REQUEST_AUTH).to(auth);
  return ctx;
}

const req = () => new Request('http://test.local/mcp', {method: 'POST'});

describe('cachedPerPrincipal', () => {
  it('runs the lookup once per principal but applies on every request', async () => {
    const app = new Context('app');
    const lookup = vi.fn((p?: AuthInfo) => [`tools-for-${p?.clientId}`]);
    const applied: string[][] = [];
    const binder = cachedPerPrincipal(lookup, (_ctx, value) =>
      applied.push(value),
    );

    for (let i = 0; i < 4; i++) {
      await binder(requestCtx(app, principal('alice')), req());
    }

    expect(lookup).toHaveBeenCalledTimes(1); // the expensive half
    expect(applied).toHaveLength(4); // the per-request half
    expect(applied.every(v => v[0] === 'tools-for-alice')).toBe(true);
  });

  it('never shares one principal answer with another', async () => {
    const app = new Context('app');
    const lookup = vi.fn((p?: AuthInfo) => p?.clientId ?? 'anon');
    const seen: string[] = [];
    const binder = cachedPerPrincipal(lookup, (_c, v) => seen.push(v));

    await binder(requestCtx(app, principal('alice')), req());
    await binder(requestCtx(app, principal('bob')), req());
    await binder(requestCtx(app, principal('alice')), req());
    await binder(requestCtx(app), req()); // anonymous

    expect(seen).toEqual(['alice', 'bob', 'alice', 'anon']);
    expect(lookup).toHaveBeenCalledTimes(3); // alice, bob, anon
  });

  it('re-keys when the same client presents different scopes', async () => {
    // A re-issued token with narrower scopes must not reuse the old answer —
    // that would be a privilege leak surviving in cache.
    const app = new Context('app');
    const lookup = vi.fn((p?: AuthInfo) => (p?.scopes ?? []).join(','));
    const seen: string[] = [];
    const binder = cachedPerPrincipal(lookup, (_c, v) => seen.push(v));

    await binder(requestCtx(app, principal('alice', ['admin'])), req());
    await binder(requestCtx(app, principal('alice', [])), req());

    expect(seen).toEqual(['admin', '']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('expires an entry after its TTL', async () => {
    vi.useFakeTimers();
    try {
      const app = new Context('app');
      const lookup = vi.fn(() => 'v');
      const binder = cachedPerPrincipal(lookup, () => {}, {ttlMs: 1000});

      await binder(requestCtx(app, principal('alice')), req());
      vi.advanceTimersByTime(999);
      await binder(requestCtx(app, principal('alice')), req());
      expect(lookup).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2);
      await binder(requestCtx(app, principal('alice')), req());
      expect(lookup).toHaveBeenCalledTimes(2); // revocation window elapsed
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not pin a failed lookup for the whole TTL', async () => {
    // A transient outage must not lock every caller out until the TTL expires.
    const app = new Context('app');
    let calls = 0;
    const lookup = vi.fn(() => {
      calls++;
      if (calls === 1) throw new Error('entitlement service down');
      return 'recovered';
    });
    const seen: string[] = [];
    const binder = cachedPerPrincipal(lookup, (_c, v) => seen.push(v), {
      ttlMs: 60_000,
    });

    await expect(
      binder(requestCtx(app, principal('alice')), req()),
    ).rejects.toThrow(/entitlement service down/);
    await binder(requestCtx(app, principal('alice')), req());

    expect(seen).toEqual(['recovered']);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('collapses a concurrent stampede into one lookup', async () => {
    const app = new Context('app');
    // Deferred built up front: `lookup` is invoked a microtask later (so a
    // synchronously-throwing lookup rejects rather than throwing out of the
    // binder), so capturing `resolve` from inside it would race this test.
    let resolve!: (v: string) => void;
    const pending = new Promise<string>(r => {
      resolve = r;
    });
    const lookup = vi.fn(() => pending);
    const binder = cachedPerPrincipal(lookup, () => {});

    const inflight = Array.from({length: 5}, () =>
      binder(requestCtx(app, principal('alice')), req()),
    );
    resolve('v');
    await Promise.all(inflight);

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest principal past `max`', async () => {
    const app = new Context('app');
    const lookup = vi.fn((p?: AuthInfo) => p?.clientId ?? '');
    const binder = cachedPerPrincipal(lookup, () => {}, {max: 2});

    await binder(requestCtx(app, principal('a')), req());
    await binder(requestCtx(app, principal('b')), req());
    await binder(requestCtx(app, principal('c')), req()); // evicts 'a'
    await binder(requestCtx(app, principal('a')), req()); // recomputed

    expect(lookup).toHaveBeenCalledTimes(4);
    await binder(requestCtx(app, principal('c')), req()); // still cached
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});
