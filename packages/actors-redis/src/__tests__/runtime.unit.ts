// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ACTOR_RUNTIME} from '@agentback/actors';
import {Application, BindingScope} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {describe, expect, it} from 'vitest';
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
