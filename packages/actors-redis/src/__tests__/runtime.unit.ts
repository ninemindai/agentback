// Copyright ninemind.ai 2026. All Rights Reserved.
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
