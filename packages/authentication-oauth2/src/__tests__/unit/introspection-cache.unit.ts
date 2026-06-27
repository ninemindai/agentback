// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {OAuth2IntrospectionService} from '../../introspection.service.js';
import type {FetchLike, OAuth2IntrospectionConfig} from '../../types.js';

/** A fetch that counts calls and returns a per-call JSON payload. */
function countingFetch(
  responder: (call: number) => {status?: number; payload: unknown},
): {fetch: FetchLike; calls(): number} {
  let calls = 0;
  const fetch: FetchLike = async () => {
    const {status = 200, payload} = responder(calls++);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  return {fetch, calls: () => calls};
}

const base: OAuth2IntrospectionConfig = {
  introspectionUrl: 'https://as.example.com/introspect',
  clientId: 'rs',
  clientSecret: 'secret',
};

/** A mutable clock for deterministic TTL tests. */
function clock(startMs = 1_000_000) {
  let nowMs = startMs;
  return {now: () => nowMs, advance: (ms: number) => (nowMs += ms)};
}

describe('OAuth2IntrospectionService caching', () => {
  it('does not cache by default — every call hits the endpoint', async () => {
    const {fetch, calls} = countingFetch(() => ({
      payload: {active: true, sub: 'u'},
    }));
    const service = new OAuth2IntrospectionService(base, fetch);

    await service.introspect('tok');
    await service.introspect('tok');

    expect(calls()).toBe(2);
  });

  it('serves a cached result within the TTL (one network call)', async () => {
    const c = clock();
    const {fetch, calls} = countingFetch(() => ({
      payload: {active: true, sub: 'u'},
    }));
    const service = new OAuth2IntrospectionService(
      {...base, cache: {ttlSeconds: 60}},
      fetch,
      c.now,
    );

    await service.introspect('tok');
    c.advance(30_000); // still within 60s
    const claims = await service.introspect('tok');

    expect(calls()).toBe(1);
    expect(claims.sub).toBe('u');
  });

  it('re-introspects after the TTL expires', async () => {
    const c = clock();
    const {fetch, calls} = countingFetch(() => ({
      payload: {active: true, sub: 'u'},
    }));
    const service = new OAuth2IntrospectionService(
      {...base, cache: {ttlSeconds: 60}},
      fetch,
      c.now,
    );

    await service.introspect('tok');
    c.advance(61_000); // past the TTL
    await service.introspect('tok');

    expect(calls()).toBe(2);
  });

  it('bounds the cache lifetime by the token exp claim', async () => {
    const c = clock(); // now = 1_000_000 ms = 1000 s
    // exp is 1010s — only 10s away, far sooner than the 1h configured TTL.
    const {fetch, calls} = countingFetch(() => ({
      payload: {active: true, sub: 'u', exp: 1010},
    }));
    const service = new OAuth2IntrospectionService(
      {...base, cache: {ttlSeconds: 3600}},
      fetch,
      c.now,
    );

    await service.introspect('tok');
    c.advance(9_000); // 9s — still before exp
    await service.introspect('tok');
    expect(calls()).toBe(1);

    c.advance(2_000); // now 11s in — past exp at 10s
    await service.introspect('tok');
    expect(calls()).toBe(2);
  });

  it('caches distinct tokens independently', async () => {
    const {fetch, calls} = countingFetch(() => ({
      payload: {active: true, sub: 'u'},
    }));
    const service = new OAuth2IntrospectionService(
      {...base, cache: true},
      fetch,
      clock().now,
    );

    await service.introspect('tok-a');
    await service.introspect('tok-b');
    await service.introspect('tok-a');

    expect(calls()).toBe(2); // a, b — second a is cached
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const {fetch, calls} = countingFetch(() => ({
      payload: {active: true, sub: 'u'},
    }));
    const service = new OAuth2IntrospectionService(
      {...base, cache: {maxEntries: 1}},
      fetch,
      clock().now,
    );

    await service.introspect('tok-a'); // call 1, caches a
    await service.introspect('tok-b'); // call 2, caches b, evicts a
    await service.introspect('tok-a'); // call 3, a was evicted → refetch

    expect(calls()).toBe(3);
  });

  it('does not cache inactive (rejected) tokens', async () => {
    const c = clock();
    // First call: inactive (throws). Second call: now active.
    const {fetch, calls} = countingFetch(call => ({
      payload: call === 0 ? {active: false} : {active: true, sub: 'u'},
    }));
    const service = new OAuth2IntrospectionService(
      {...base, cache: true},
      fetch,
      c.now,
    );

    await expect(service.introspect('tok')).rejects.toMatchObject({
      statusCode: 401,
    });
    const claims = await service.introspect('tok');

    expect(calls()).toBe(2);
    expect(claims.active).toBe(true);
  });
});
