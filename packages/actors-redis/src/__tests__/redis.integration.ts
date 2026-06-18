// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {defineActor} from '@agentback/actors';
import {runActorRuntimeConformance} from '@agentback/actors/testing';
import {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RedisActorRuntime} from '../redis-actor-runtime.js';

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  describe.skip('RedisActorRuntime integration (REDIS_URL not set)', () => {
    it('requires Redis', () => {});
  });
} else {
  const connections = new RedisConnectionManager({url: REDIS_URL});
  const testPrefix = `agentback:test:actors:${crypto.randomUUID()}`;
  let runtimeNumber = 0;
  const runtime = (suffix = String(runtimeNumber++)) =>
    new RedisActorRuntime(connections, {
      prefix: `${testPrefix}:${suffix}`,
      leaseMs: 1_000,
      leaseRetryMs: 5,
      acquireTimeoutMs: 2_000,
      dedupTtlSeconds: 60,
    });

  runActorRuntimeConformance('redis', () => runtime());

  describe('RedisActorRuntime distributed semantics', () => {
    const State = z.object({value: z.number()});
    const Command = z.object({amount: z.number(), waitMs: z.number()});
    const Result = z.object({value: z.number()});

    const Counter = defineActor('redis-counter', {
      state: State,
      command: Command,
      result: Result,
      initialState: () => ({value: 0}),
      async receive(_ctx, state, command) {
        if (command.waitMs) {
          await new Promise<void>(resolve =>
            setTimeout(resolve, command.waitMs),
          );
        }
        state.value += command.amount;
        return {state, result: {value: state.value}};
      },
    });

    it('serializes the same actor across runtime instances', async () => {
      const firstRuntime = runtime('shared-runtime');
      const secondRuntime = runtime('shared-runtime');
      firstRuntime.register(Counter);
      secondRuntime.register(Counter);

      const results = await Promise.all([
        firstRuntime
          .ref(Counter, 'one')
          .invoke({amount: 1, waitMs: 30}, {requestId: 'first'}),
        secondRuntime
          .ref(Counter, 'one')
          .invoke({amount: 1, waitMs: 0}, {requestId: 'second'}),
      ]);

      expect(results.map(result => result.value).sort()).toEqual([1, 2]);
      expect(await firstRuntime.state(Counter, 'one')).toEqual({value: 2});
    });

    it('replays a request committed by another runtime instance', async () => {
      const firstRuntime = runtime('shared-dedup');
      const secondRuntime = runtime('shared-dedup');
      firstRuntime.register(Counter);
      secondRuntime.register(Counter);

      const first = await firstRuntime
        .ref(Counter, 'one')
        .invoke({amount: 4, waitMs: 0}, {requestId: 'same'});
      const replay = await secondRuntime
        .ref(Counter, 'one')
        .invoke({amount: 4, waitMs: 0}, {requestId: 'same'});

      expect(replay).toEqual(first);
      expect(await firstRuntime.state(Counter, 'one')).toEqual({value: 4});
    });
  });

  afterAll(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await connections.base.scan(
        cursor,
        'MATCH',
        `${testPrefix}:*`,
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length) await connections.base.del(...keys);
    } while (cursor !== '0');
    await connections.close();
  });
}
