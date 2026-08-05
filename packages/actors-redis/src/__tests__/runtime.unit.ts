// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ACTOR_RUNTIME} from '@agentback/actors';
import {Application, BindingScope} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {describe, expect, it, vi} from 'vitest';
import {REDIS_ACTOR_OWNS_CONNECTIONS} from '../keys.js';
import {RedisActorRuntime} from '../redis-actor-runtime.js';
import {installRedisActors} from '../redis-actors.component.js';

describe('RedisActorRuntime configuration', () => {
  const connections = {} as RedisConnectionManager;

  it('rejects invalid lease and retention settings', () => {
    expect(() => new RedisActorRuntime(connections, {leaseMs: 0})).toThrow(
      'leaseMs',
    );
    expect(
      () => new RedisActorRuntime(connections, {dedupTtlSeconds: -1}),
    ).toThrow('dedupTtlSeconds');
  });

  // EXPIRE runs mid-commit, after state and the dedup record are written, and
  // raises on a fractional or out-of-range TTL. A rejected constructor is what
  // keeps that from ever splitting the commit.
  it('rejects a dedup TTL that EXPIRE would refuse', () => {
    for (const dedupTtlSeconds of [0.5, 1e16, Number.NaN, Infinity]) {
      expect(
        () => new RedisActorRuntime(connections, {dedupTtlSeconds}),
      ).toThrow('dedupTtlSeconds must be a whole number of seconds');
    }
  });

  it('accepts whole-second TTLs, including 0 (no expiry)', () => {
    for (const dedupTtlSeconds of [0, 1, 86_400]) {
      expect(
        () => new RedisActorRuntime(connections, {dedupTtlSeconds}),
      ).not.toThrow();
    }
  });

  it('binds a singleton runtime without taking ownership of a shared manager', async () => {
    const app = new Application();
    installRedisActors(app, {connections});

    const binding = app.getBinding(ACTOR_RUNTIME);
    expect(binding.scope).toBe(BindingScope.SINGLETON);
    expect(binding.valueConstructor).toBe(RedisActorRuntime);
    expect(await app.get(REDIS_ACTOR_OWNS_CONNECTIONS)).toBe(false);
    expect(await app.get(ACTOR_RUNTIME)).toBe(await app.get(ACTOR_RUNTIME));
  });
});

/**
 * The renewal cap is a timer policy over deadlines measured in seconds and
 * minutes, so it is pinned here with fake timers rather than by waiting. What
 * it *achieves* — a seat that is claimable again after a timed-out turn — is
 * covered end-to-end in `redis.integration.ts`.
 */
describe('RedisActorRuntime lease renewal cap', () => {
  type RenewalInternals = {
    startRenewal(
      lease: {
        value: string;
        lost: boolean;
        timer?: ReturnType<typeof setInterval>;
      },
      keys: {lease: string},
      deadlineMs: number,
    ): void;
    evalNumber(script: string, keys: string[], args: string[]): Promise<number>;
  };

  function renewalHarness(leaseMs: number) {
    const runtime = new RedisActorRuntime({} as RedisConnectionManager, {
      leaseMs,
    });
    const internals = runtime as unknown as RenewalInternals;
    const renew = vi
      .spyOn(internals, 'evalNumber')
      .mockResolvedValue(1) as unknown as {mock: {calls: unknown[]}};
    const lease = {value: 'token', lost: false};
    return {internals, lease, renew};
  }

  it('stops renewing once a turn has outlived its deadline, and marks the lease lost', async () => {
    vi.useFakeTimers();
    try {
      // leaseMs 300 → renewals every 100ms. A 250ms deadline is covered by
      // ceil(250 / 100) = 3 renewals; the 4th tick stops the loop instead.
      const {internals, lease, renew} = renewalHarness(300);
      internals.startRenewal(lease, {lease: 'k'}, 250);

      await vi.advanceTimersByTimeAsync(250);
      expect(renew.mock.calls).toHaveLength(2);
      expect(lease.lost).toBe(false);

      // Well past the deadline: renewals have stopped for good, so the lease
      // lapses on its own PEXPIRE and the seat becomes claimable.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(renew.mock.calls).toHaveLength(3);
      expect(lease.lost).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps against the renewal interval, not leaseMs — a long turn keeps its lease', async () => {
    vi.useFakeTimers();
    try {
      // A worker-band turn: leaseMs 300 (interval 100ms), deadline 10s. A cap
      // of deadlineMs/leaseMs would be 33 renewals ≈ 3.3s and would cut the
      // turn short at a third of its deadline; the interval-based cap is 100.
      const {internals, lease, renew} = renewalHarness(300);
      internals.startRenewal(lease, {lease: 'k'}, 10_000);

      await vi.advanceTimersByTimeAsync(9_000);
      expect(lease.lost).toBe(false);
      expect(renew.mock.calls).toHaveLength(90);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(renew.mock.calls).toHaveLength(100);
      expect(lease.lost).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
