// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it, vi} from 'vitest';
import {Context} from '@agentback/core';
import {MCPBindings} from '@agentback/mcp';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {cachedPerPrincipal} from '../../binder-cache.js';

// Under `protocol: 'both'` the binder runs on EVERY request, so an
// entitlement lookup inside it becomes a per-request database query. That
// failure mode is a quiet load multiplier, not an error, which is what these
// tests pin down. Only `lookup` is cached — `apply` must still run per request
// against that request's own context.

const principal = (
  subject: string,
  scopes: string[] = [],
  clientId = 'shared-oauth-client',
): AuthInfo => ({
  token: 't',
  // Deliberately the SAME for every principal by default: under OAuth this is
  // the client APPLICATION id, shared across end users. Tests must key on the
  // subject, never on this.
  clientId,
  scopes,
  extra: {sub: subject},
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

/** The identity key a real app supplies: subject plus granted scopes. */
const bySubject = (p?: AuthInfo) =>
  `${p?.extra?.sub ?? 'anon'}|${[...(p?.scopes ?? [])].sort().join(' ')}`;

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
    const lookup = vi.fn((p?: AuthInfo) => [`tools-for-${p?.extra?.sub}`]);
    const applied: string[][] = [];
    const binder = cachedPerPrincipal(
      lookup,
      (_ctx, value) => applied.push(value),
      {keyOf: bySubject},
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
    const lookup = vi.fn((p?: AuthInfo) => String(p?.extra?.sub ?? 'anon'));
    const seen: string[] = [];
    const binder = cachedPerPrincipal(lookup, (_c, v) => seen.push(v), {
      keyOf: bySubject,
    });

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
    const binder = cachedPerPrincipal(lookup, (_c, v) => seen.push(v), {
      keyOf: bySubject,
    });

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
      const binder = cachedPerPrincipal(lookup, () => {}, {
        keyOf: bySubject,
        ttlMs: 1000,
      });

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
      keyOf: bySubject,
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
    const binder = cachedPerPrincipal(lookup, () => {}, {keyOf: bySubject});

    const inflight = Array.from({length: 5}, () =>
      binder(requestCtx(app, principal('alice')), req()),
    );
    resolve('v');
    await Promise.all(inflight);

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest principal past `max`', async () => {
    const app = new Context('app');
    const lookup = vi.fn((p?: AuthInfo) => String(p?.extra?.sub ?? ''));
    const binder = cachedPerPrincipal(lookup, () => {}, {
      keyOf: bySubject,
      max: 2,
    });

    await binder(requestCtx(app, principal('a')), req());
    await binder(requestCtx(app, principal('b')), req());
    await binder(requestCtx(app, principal('c')), req()); // evicts 'a'
    await binder(requestCtx(app, principal('a')), req()); // recomputed

    expect(lookup).toHaveBeenCalledTimes(4);
    await binder(requestCtx(app, principal('c')), req()); // still cached
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});

// The finding this cache's API shape exists to prevent. `AuthInfo.clientId` is
// the OAuth CLIENT APPLICATION id — every end user signing in through the same
// app carries the same one. A cache keyed on it would serve user A's tool list
// to user B automatically, with no stolen token involved. `keyOf` is required
// precisely so that key can never be guessed by the framework.
describe('cross-user isolation under a shared OAuth client', () => {
  it('does not collide two subjects that share a clientId', async () => {
    const app = new Context('app');
    const lookup = vi.fn((p?: AuthInfo) => `tools-for-${p?.extra?.sub}`);
    const seen: string[] = [];
    const binder = cachedPerPrincipal(lookup, (_c, v) => seen.push(v), {
      keyOf: bySubject,
    });

    // Same client app, same scopes, different humans.
    const alice = principal('alice', ['mcp'], 'acme-web-app');
    const bob = principal('bob', ['mcp'], 'acme-web-app');
    expect(alice.clientId).toBe(bob.clientId);

    await binder(requestCtx(app, alice), req());
    await binder(requestCtx(app, bob), req());

    expect(seen).toEqual(['tools-for-alice', 'tools-for-bob']);
    expect(lookup).toHaveBeenCalledTimes(2); // NOT served from one entry
  });

  it('would have collided under a clientId-based key', async () => {
    // Pins WHY keyOf is required: the same cache, keyed the tempting way,
    // demonstrably leaks across users. If this ever stops colliding, the
    // hazard has changed and the required-keyOf design can be revisited.
    const app = new Context('app');
    const lookup = vi.fn((p?: AuthInfo) => `tools-for-${p?.extra?.sub}`);
    const seen: string[] = [];
    const binder = cachedPerPrincipal(lookup, (_c, v) => seen.push(v), {
      keyOf: p => `${p?.clientId} ${[...(p?.scopes ?? [])].sort().join(' ')}`,
    });

    await binder(requestCtx(app, principal('alice', ['mcp'], 'acme')), req());
    await binder(requestCtx(app, principal('bob', ['mcp'], 'acme')), req());

    expect(seen).toEqual(['tools-for-alice', 'tools-for-alice']); // bob sees alice
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
