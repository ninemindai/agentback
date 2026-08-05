// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {defineActor} from '@agentback/actors';
import {
  runActorEventStoreConformance,
  runActorRuntimeConformance,
} from '@agentback/actors/testing';
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
  runActorEventStoreConformance('redis', () => runtime());

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

  describe('RedisActorRuntime journal durability', () => {
    const JournalState = z.object({count: z.number()});
    const JournalCommand = z.object({by: z.number()});

    /** The key layout COMMIT_TURN writes, for tests that squat on a key. */
    const keyBase = (prefix: string, type: string, id: string) =>
      `${prefix}:{${encodeURIComponent(type)}:${encodeURIComponent(id)}}`;

    function journal(options: {onTurn?: () => void; seatKeyId?: string} = {}) {
      return defineActor('redis-journal', {
        state: JournalState,
        command: JournalCommand,
        result: JournalState,
        initialState: () => ({count: 0}),
        receive(_ctx, state, command) {
          options.onTurn?.();
          state.count += command.by;
          return {
            state,
            result: state,
            events: [{type: 'Incremented', by: command.by}],
            seatKeyId: options.seatKeyId,
          };
        },
      });
    }

    it('a process killed mid-turn leaves exactly the turns that committed', async () => {
      // The gate: three turns commit, the fourth dies before its Lua runs.
      // A brand new process, new connection, reads exactly three events.
      const prefix = `${testPrefix}:crash`;
      const dying = new RedisConnectionManager({url: REDIS_URL});
      let kill = false;
      const definition = journal({
        onTurn: () => {
          if (kill) dying.base.disconnect();
        },
      });
      const doomed = new RedisActorRuntime(dying, {
        prefix,
        leaseMs: 1_000,
        leaseRetryMs: 5,
        acquireTimeoutMs: 2_000,
      });
      doomed.register(definition);

      for (const n of [0, 1, 2]) {
        await doomed
          .ref(definition, 'crash')
          .invoke({by: 1}, {requestId: `r${n}`});
      }
      kill = true;
      await expect(
        doomed.ref(definition, 'crash').invoke({by: 1}, {requestId: 'r3'}),
      ).rejects.toThrow();

      const reborn = new RedisActorRuntime(connections, {prefix});
      const rebornDefinition = journal();
      reborn.register(rebornDefinition);
      const log = await reborn.events('redis-journal', 'crash');
      expect(log.map(entry => entry.seq)).toEqual([0, 1, 2]);
      expect(log.map(entry => entry.requestId)).toEqual(['r0', 'r1', 'r2']);
      expect(await reborn.state(rebornDefinition, 'crash')).toEqual({count: 3});
    });

    it('commits nothing when the commit script fails outright', async () => {
      // A hash squatting on the sequence key makes the script's INCRBY raise a
      // real Lua error. Redis does not roll back a half-run script, so this is
      // the load-bearing case: the commit is safe only because that INCRBY is
      // the first write in the script.
      const prefix = `${testPrefix}:lua-error`;
      const base = keyBase(prefix, 'redis-journal', 'boom');
      await connections.base.hset(`${base}:seq`, 'squatter', '1');

      const journalRuntime = new RedisActorRuntime(connections, {prefix});
      const definition = journal();
      journalRuntime.register(definition);

      await expect(
        journalRuntime
          .ref(definition, 'boom')
          .invoke({by: 1}, {requestId: 'r1'}),
      ).rejects.toThrow(/WRONGTYPE/);

      expect(await connections.base.exists(`${base}:state`)).toBe(0);
      expect(await connections.base.exists(`${base}:dedup`)).toBe(0);
      expect(await connections.base.exists(`${base}:log`)).toBe(0);
      expect(await journalRuntime.state(definition, 'boom')).toEqual({
        count: 0,
      });
      expect(await journalRuntime.events('redis-journal', 'boom')).toEqual([]);
    });

    it('commits nothing when a target key holds the wrong type', async () => {
      // Same invariant one rung earlier: the script refuses before its first
      // write rather than discovering the bad key halfway through.
      const prefix = `${testPrefix}:wrong-type`;
      const base = keyBase(prefix, 'redis-journal', 'squatted');
      await connections.base.set(`${base}:log`, 'not-a-stream');

      const journalRuntime = new RedisActorRuntime(connections, {prefix});
      const definition = journal();
      journalRuntime.register(definition);

      await expect(
        journalRuntime
          .ref(definition, 'squatted')
          .invoke({by: 1}, {requestId: 'r1'}),
      ).rejects.toThrow(/unexpected types/);

      expect(await connections.base.exists(`${base}:state`)).toBe(0);
      expect(await connections.base.exists(`${base}:dedup`)).toBe(0);
      expect(await connections.base.exists(`${base}:seq`)).toBe(0);
      expect(await connections.base.get(`${base}:log`)).toBe('not-a-stream');
    });

    it('applies the dedup TTL without breaking the commit apart', async () => {
      const prefix = `${testPrefix}:ttl`;
      const base = keyBase(prefix, 'redis-journal', 'ttl');
      const ttlRuntime = new RedisActorRuntime(connections, {
        prefix,
        dedupTtlSeconds: 60,
      });
      const definition = journal();
      ttlRuntime.register(definition);

      await ttlRuntime
        .ref(definition, 'ttl')
        .invoke({by: 1}, {requestId: 'r1'});

      expect(await connections.base.ttl(`${base}:dedup`)).toBeGreaterThan(0);
      expect(await ttlRuntime.events('redis-journal', 'ttl')).toHaveLength(1);
    });

    it('keeps the commit whole even if a fractional TTL reaches the script', async () => {
      // The constructor rejects this value, so reach past it — a future config
      // path must not be able to reopen the hole. EXPIRE raises on '0.5' and it
      // runs after state and dedup are written, so an unguarded script would
      // commit those two and lose the events. The script floors the TTL
      // instead: retention is skipped, the commit stays whole.
      const prefix = `${testPrefix}:ttl-fractional`;
      const base = keyBase(prefix, 'redis-journal', 'fractional');
      const ttlRuntime = new RedisActorRuntime(connections, {prefix});
      Object.defineProperty(ttlRuntime, 'dedupTtlSeconds', {value: 0.5});
      const definition = journal();
      ttlRuntime.register(definition);

      await ttlRuntime
        .ref(definition, 'fractional')
        .invoke({by: 1}, {requestId: 'r1'});

      expect(await ttlRuntime.state(definition, 'fractional')).toEqual({
        count: 1,
      });
      expect(await connections.base.hlen(`${base}:dedup`)).toBe(1);
      expect(await connections.base.ttl(`${base}:dedup`)).toBe(-1); // no expiry
      const log = await ttlRuntime.events('redis-journal', 'fractional');
      expect(log.map(entry => entry.seq)).toEqual([0]);
    });

    it('rejects a journal entry whose seq is not a number', async () => {
      const prefix = `${testPrefix}:foreign-entry`;
      const base = keyBase(prefix, 'redis-journal', 'foreign');
      await connections.base.xadd(
        `${base}:log`,
        '*',
        'seq',
        'not-a-number',
        'event',
        '{"type":"Foreign"}',
      );

      const foreignRuntime = new RedisActorRuntime(connections, {prefix});
      await expect(
        foreignRuntime.events('redis-journal', 'foreign'),
      ).rejects.toThrow(/non-numeric seq/);
    });

    it('journals the acting seat key id, and omits it when there is none', async () => {
      const signedRuntime = runtime('seat-key');
      const withSeat = journal({seatKeyId: 'seat-key-abc'});
      signedRuntime.register(withSeat);
      await signedRuntime
        .ref(withSeat, 'signed')
        .invoke({by: 1}, {requestId: 'r1'});

      const keylessRuntime = runtime('seat-key-none');
      const anonymous = journal();
      keylessRuntime.register(anonymous);
      await keylessRuntime
        .ref(anonymous, 'unsigned')
        .invoke({by: 1}, {requestId: 'r1'});

      const [signed] = await signedRuntime.events('redis-journal', 'signed');
      expect(signed?.seatKeyId).toBe('seat-key-abc');
      const [unsigned] = await keylessRuntime.events(
        'redis-journal',
        'unsigned',
      );
      expect(unsigned).toBeDefined();
      expect(unsigned).not.toHaveProperty('seatKeyId');
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
