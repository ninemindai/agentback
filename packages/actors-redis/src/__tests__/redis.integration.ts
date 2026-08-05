// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ACTOR_TURN_TIMEOUT_EVENT,
  defineActor,
  TurnTimeoutError,
} from '@agentback/actors';
import {
  runActorEventStoreConformance,
  runActorRuntimeConformance,
} from '@agentback/actors/testing';
import {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  RedisActorRuntime,
  type RedisActorRuntimeOptions,
} from '../redis-actor-runtime.js';

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  describe.skip('RedisActorRuntime integration (REDIS_URL not set)', () => {
    it('requires Redis', () => {});
  });
} else {
  const connections = new RedisConnectionManager({url: REDIS_URL});
  const testPrefix = `agentback:test:actors:${crypto.randomUUID()}`;
  let runtimeNumber = 0;
  const runtime = (
    suffix = String(runtimeNumber++),
    overrides: Partial<RedisActorRuntimeOptions> = {},
  ) =>
    new RedisActorRuntime(connections, {
      prefix: `${testPrefix}:${suffix}`,
      leaseMs: 1_000,
      leaseRetryMs: 5,
      acquireTimeoutMs: 2_000,
      dedupTtlSeconds: 60,
      ...overrides,
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
        receive(ctx, state, command) {
          options.onTurn?.();
          state.count += command.by;
          // seatKeyId is a raw defineActor caller's to set — but on ctx, not
          // the turn (see ActorCommandContext.seatKeyId); the runtime reads
          // it back after receive() resolves.
          if (options.seatKeyId !== undefined)
            ctx.seatKeyId = options.seatKeyId;
          return {
            state,
            result: state,
            events: [{type: 'Incremented', by: command.by}],
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

    it('releases the seat in Redis when a turn misses its deadline', async () => {
      // The conformance suite proves the next turn runs; this proves the
      // distributed mechanism behind it — the lease key itself is gone, so
      // any process may claim the seat, not just this one.
      const prefix = `${testPrefix}:deadline`;
      const base = keyBase(prefix, 'redis-deadline', 'wedged');
      const deadlineRuntime = new RedisActorRuntime(connections, {
        prefix,
        leaseMs: 1_000,
        leaseRetryMs: 5,
        acquireTimeoutMs: 2_000,
      });
      const definition = defineActor('redis-deadline', {
        state: JournalState,
        command: JournalCommand,
        result: JournalState,
        deadlineMs: 50,
        initialState: () => ({count: 0}),
        async receive() {
          await new Promise<never>(() => {});
          throw new Error('unreachable');
        },
      });
      deadlineRuntime.register(definition);

      await expect(
        deadlineRuntime
          .ref(definition, 'wedged')
          .invoke({by: 1}, {requestId: 'hangs'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);

      expect(await connections.base.exists(`${base}:lease`)).toBe(0);
      // Nothing of the failed turn reached state or dedup — only the journal.
      expect(await connections.base.exists(`${base}:state`)).toBe(0);
      expect(await connections.base.exists(`${base}:dedup`)).toBe(0);
      const journal = await deadlineRuntime.events('redis-deadline', 'wedged');
      expect(journal.map(entry => entry.event.type)).toEqual([
        ACTOR_TURN_TIMEOUT_EVENT,
      ]);
    });

    it('journals a cold identity whose initialState misses the deadline', async () => {
      // The state load is inside the race now, so this turn times out before
      // `receive` is ever reached — on an identity that has NO stream yet.
      // `APPEND_TURN_FAILURE` has to create both the counter and the stream
      // for the marker to exist at all, which is what makes the caller-visible
      // half (the conformance case) a *recorded* failed turn here.
      const prefix = `${testPrefix}:cold-init`;
      const base = keyBase(prefix, 'redis-cold-init', 'cold');
      const coldRuntime = new RedisActorRuntime(connections, {
        prefix,
        leaseMs: 1_000,
        leaseRetryMs: 5,
        acquireTimeoutMs: 2_000,
      });
      let slowInit = true;
      const definition = defineActor('redis-cold-init', {
        state: JournalState,
        command: JournalCommand,
        result: JournalState,
        deadlineMs: 50,
        initialState: async () => {
          if (slowInit) await new Promise<never>(() => {});
          return {count: 0};
        },
        receive(_ctx, state, command) {
          state.count += command.by;
          return {
            state,
            result: state,
            events: [{type: 'Incremented', by: command.by}],
          };
        },
      });
      coldRuntime.register(definition);

      await expect(
        coldRuntime.ref(definition, 'cold').invoke({by: 1}, {requestId: 'r0'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);

      // Recorded, rolled back, and the seat left claimable by any process.
      const marker = await coldRuntime.events('redis-cold-init', 'cold');
      expect(marker.map(entry => entry.event.type)).toEqual([
        ACTOR_TURN_TIMEOUT_EVENT,
      ]);
      expect(marker[0]?.seq).toBe(0);
      expect(marker[0]?.requestId).toBe('r0');
      expect(await connections.base.exists(`${base}:lease`)).toBe(0);
      expect(await connections.base.exists(`${base}:state`)).toBe(0);
      expect(await connections.base.exists(`${base}:dedup`)).toBe(0);

      // The next turn loads fast and commits immediately, after the marker.
      slowInit = false;
      expect(
        await coldRuntime.ref(definition, 'cold').invoke(
          {by: 2},
          {
            requestId: 'r1',
          },
        ),
      ).toEqual({count: 2});
      const log = await coldRuntime.events('redis-cold-init', 'cold');
      expect(log.map(entry => entry.event.type)).toEqual([
        ACTOR_TURN_TIMEOUT_EVENT,
        'Incremented',
      ]);
      expect(log.map(entry => entry.seq)).toEqual([0, 1]);
    });

    it('trims a capped journal to its tail, leaving seq numbering alone', async () => {
      // Retention is opt-in and lands inside the commit script, so the one
      // commit point stays one script. What must survive it is the numbering:
      // `seq` comes from the counter, never from stream length, so a trimmed
      // log reads as a *suffix* — the surviving entries keep the seq values
      // they were committed with.
      const capped = runtime('retention', {
        journal: {maxEventsPerIdentity: 5},
      });
      const definition = journal();
      capped.register(definition);
      for (let n = 0; n < 10; n++) {
        await capped
          .ref(definition, 'trim')
          .invoke({by: 1}, {requestId: `r${n}`});
      }

      const log = await capped.events('redis-journal', 'trim');
      expect(log.map(entry => entry.seq)).toEqual([5, 6, 7, 8, 9]);
      // Trimming touches the journal and nothing else.
      expect(await capped.state(definition, 'trim')).toEqual({count: 10});

      // Unset (the default) keeps everything, on the same shape of turn.
      const uncapped = runtime('retention-off');
      const kept = journal();
      uncapped.register(kept);
      for (let n = 0; n < 10; n++) {
        await uncapped.ref(kept, 'keep').invoke({by: 1}, {requestId: `r${n}`});
      }
      expect(
        (await uncapped.events('redis-journal', 'keep')).map(e => e.seq),
      ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('keeps the commit whole at a cap Lua would render in exponent form', async () => {
      // `redis.call` converts a Lua number with its *shortest* round-trip
      // decimal form, so a round value at or above 1e8 arrives as `1e+8` and
      // XADD rejects it as a non-integer — after INCRBY, SET and HSET have
      // already landed. That splits the one commit point: state and dedup
      // committed, the journal entry lost, the seq burned, and the caller told
      // its committed turn failed. The numeric arguments therefore travel as
      // the raw ARGV strings.
      const prefix = `${testPrefix}:exponent-cap`;
      const base = keyBase(prefix, 'redis-journal', 'huge');
      const capped = runtime('exponent-cap', {
        journal: {maxEventsPerIdentity: 100_000_000},
      });
      const definition = journal();
      capped.register(definition);

      expect(
        await capped.ref(definition, 'huge').invoke({by: 1}, {requestId: 'r0'}),
      ).toEqual({count: 1});
      const log = await capped.events('redis-journal', 'huge');
      expect(log.map(entry => entry.seq)).toEqual([0]);
      expect(await capped.state(definition, 'huge')).toEqual({count: 1});
      expect(await connections.base.hlen(`${base}:dedup`)).toBe(1);
    });

    it('journals a failed turn at a cap Lua would render in exponent form', async () => {
      // The marker append has the same shape and the same hazard, and it fails
      // more quietly: `recordTimedOutTurn` logs and moves on, so a raising XADD
      // costs the record that "a timeout is a recorded failed turn" depends on.
      const capped = runtime('exponent-cap-marker', {
        journal: {maxEventsPerIdentity: 100_000_000},
      });
      const definition = defineActor('redis-marker-exponent', {
        state: JournalState,
        command: JournalCommand,
        result: JournalState,
        deadlineMs: 30,
        initialState: () => ({count: 0}),
        async receive() {
          await new Promise<never>(() => {});
          throw new Error('unreachable');
        },
      });
      capped.register(definition);

      await expect(
        capped.ref(definition, 'wedged').invoke({by: 1}, {requestId: 'r0'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);
      const log = await capped.events('redis-marker-exponent', 'wedged');
      expect(log.map(entry => entry.event.type)).toEqual([
        ACTOR_TURN_TIMEOUT_EVENT,
      ]);
      expect(log.map(entry => entry.seq)).toEqual([0]);
    });

    it('applies a dedup TTL Lua would render in exponent form', async () => {
      // Same defect, same script, older write: EXPIRE runs *after* state and
      // dedup are written, so a TTL that arrives as `1e+8` raises mid-commit
      // and loses the journal entry. 100_000_000 is a legal `dedupTtlSeconds`
      // (~3 years), well inside MAX_DEDUP_TTL_SECONDS.
      const prefix = `${testPrefix}:exponent-ttl`;
      const base = keyBase(prefix, 'redis-journal', 'ttl');
      const ttlRuntime = runtime('exponent-ttl', {
        dedupTtlSeconds: 100_000_000,
      });
      const definition = journal();
      ttlRuntime.register(definition);

      await ttlRuntime
        .ref(definition, 'ttl')
        .invoke({by: 1}, {requestId: 'r0'});

      expect(await connections.base.ttl(`${base}:dedup`)).toBeGreaterThan(0);
      expect(await ttlRuntime.state(definition, 'ttl')).toEqual({count: 1});
      expect(
        (await ttlRuntime.events('redis-journal', 'ttl')).map(e => e.seq),
      ).toEqual([0]);
    });

    it('caps a journal made only of failed-turn markers too', async () => {
      // The marker is its own write, outside the commit script, so retention
      // has to be applied there as well — otherwise an identity that only ever
      // times out grows without bound and the cap is not a cap.
      const capped = runtime('retention-markers', {
        journal: {maxEventsPerIdentity: 2},
      });
      const definition = defineActor('redis-marker-retention', {
        state: JournalState,
        command: JournalCommand,
        result: JournalState,
        deadlineMs: 30,
        initialState: () => ({count: 0}),
        async receive() {
          await new Promise<never>(() => {});
          throw new Error('unreachable');
        },
      });
      capped.register(definition);
      for (const n of [0, 1, 2]) {
        await expect(
          capped
            .ref(definition, 'wedged')
            .invoke({by: 1}, {requestId: `r${n}`}),
        ).rejects.toBeInstanceOf(TurnTimeoutError);
      }

      const log = await capped.events('redis-marker-retention', 'wedged');
      expect(log.map(entry => entry.seq)).toEqual([1, 2]);
      expect(log.map(entry => entry.event.type)).toEqual([
        ACTOR_TURN_TIMEOUT_EVENT,
        ACTOR_TURN_TIMEOUT_EVENT,
      ]);
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

    it("journals the acting seat key id, and the '' sentinel when there is none", async () => {
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
      expect(unsigned?.seatKeyId).toBe('');
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
