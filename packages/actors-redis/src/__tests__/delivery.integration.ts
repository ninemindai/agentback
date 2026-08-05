// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ACTOR_REGISTRY,
  ACTOR_RUNTIME,
  SEAT_JOURNAL_CONSUMER,
  defineActor,
  type CommittedActorEvent,
} from '@agentback/actors';
import {LogLevel, enableDebug, onLog} from '@agentback/common';
import {Application, Binding, extensionFor} from '@agentback/core';
import {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  RedisActorRuntime,
  type RedisActorRuntimeOptions,
} from '../redis-actor-runtime.js';
import {installRedisActors} from '../redis-actors.component.js';

const REDIS_URL = process.env.REDIS_URL;

/** Poll `check` until it holds, or fail loudly with what was actually seen. */
async function waitFor(
  check: () => boolean,
  describeState: () => string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting: ${describeState()}`);
}

if (!REDIS_URL) {
  describe.skip('Redis journal delivery (REDIS_URL not set)', () => {
    it('requires Redis', () => {});
  });
} else {
  const connections = new RedisConnectionManager({url: REDIS_URL});
  const testPrefix = `agentback:test:delivery:${crypto.randomUUID()}`;

  const JournalState = z.object({count: z.number()});
  const JournalCommand = z.object({by: z.number()});
  const TYPE = 'delivery-journal';

  function journal() {
    return defineActor(TYPE, {
      state: JournalState,
      command: JournalCommand,
      result: JournalState,
      initialState: () => ({count: 0}),
      receive(_ctx, state, command) {
        state.count += command.by;
        return {
          state,
          result: state,
          events: [{type: 'Incremented', by: command.by}],
        };
      },
    });
  }

  /**
   * A runtime on `prefix`. Two runtimes sharing a prefix model two processes
   * against the same durable journal — which is how the restart gate below
   * gets a genuinely fresh in-process cursor.
   */
  const runtime = (
    suffix: string,
    overrides: Partial<RedisActorRuntimeOptions> = {},
  ) =>
    new RedisActorRuntime(connections, {
      prefix: `${testPrefix}:${suffix}`,
      leaseMs: 1_000,
      leaseRetryMs: 5,
      acquireTimeoutMs: 2_000,
      dedupTtlSeconds: 60,
      blockMs: 50,
      discoveryIntervalMs: 20,
      ...overrides,
    });

  const eventKey = (event: CommittedActorEvent) =>
    `${event.actor.type}/${event.actor.id}#${event.seq}`;

  describe('Redis journal delivery', () => {
    it('delivers every committed event to every subscriber (no gate in the fan-out path)', async () => {
      const rt = runtime('fanout');
      const definition = journal();
      rt.register(definition);

      const first: CommittedActorEvent[] = [];
      const second: CommittedActorEvent[] = [];
      const offFirst = rt.subscribe(event => void first.push(event));
      const offSecond = rt.subscribe(event => void second.push(event));
      try {
        await rt.ref(definition, 'x').invoke({by: 1}, {requestId: 'r1'});
        await rt.ref(definition, 'y').invoke({by: 2}, {requestId: 'r2'});
        await rt.ref(definition, 'x').invoke({by: 3}, {requestId: 'r3'});

        const expected = [`${TYPE}/x#0`, `${TYPE}/x#1`, `${TYPE}/y#0`].sort();
        await waitFor(
          () => first.length >= 3 && second.length >= 3,
          () => `first=${first.length} second=${second.length}`,
        );

        // Structural: both subscribers saw the whole population, and every
        // committed event carries its seat key id through delivery.
        expect([...new Set(first.map(eventKey))].sort()).toEqual(expected);
        expect([...new Set(second.map(eventKey))].sort()).toEqual(expected);
        expect(first.every(event => typeof event.seatKeyId === 'string')).toBe(
          true,
        );
      } finally {
        offFirst();
        offSecond();
        await rt.stopDelivery();
      }
    });

    it('replays a killed subscriber at-least-once; the consumer dedups by (actor, seq)', async () => {
      // The gate. One consumer, two subscriber lifetimes: the second is a
      // different runtime instance (a fresh process), so it carries no
      // in-process cursor and re-reads the durable log from the start.
      const seen = new Set<string>();
      let rawDeliveries = 0;
      const consume = (event: CommittedActorEvent) => {
        rawDeliveries++;
        seen.add(eventKey(event));
      };

      const before = runtime('restart');
      const definition = journal();
      before.register(definition);
      const ref = before.ref(definition, 'k');

      await ref.invoke({by: 1}, {requestId: 'r0'});
      await ref.invoke({by: 1}, {requestId: 'r1'});

      const off = before.subscribe(consume);
      await waitFor(
        () => seen.size === 2,
        () => `seen=${[...seen].join(',')}`,
      );

      // Killed mid-stream: the tail stops, but the journal keeps growing.
      off();
      await before.stopDelivery();
      await ref.invoke({by: 1}, {requestId: 'r2'});
      await ref.invoke({by: 1}, {requestId: 'r3'});

      const after = runtime('restart');
      const restarted = after.subscribe(consume);
      try {
        await waitFor(
          () => seen.size === 4,
          () => `seen=${[...seen].join(',')}`,
        );
        // Exactly-once by the consumer's own dedup...
        expect([...seen].sort()).toEqual([
          `${TYPE}/k#0`,
          `${TYPE}/k#1`,
          `${TYPE}/k#2`,
          `${TYPE}/k#3`,
        ]);
        // ...over an at-least-once harness: the restart re-delivered the two
        // events the first lifetime had already handed over.
        expect(rawDeliveries).toBeGreaterThan(seen.size);
      } finally {
        restarted();
        await after.stopDelivery();
      }
    });

    it('resumes from a cursor the consumer persisted, replaying only seq > cursor', async () => {
      const rt = runtime('cursor');
      const definition = journal();
      rt.register(definition);
      const ref = rt.ref(definition, 'c');
      for (const n of [0, 1, 2]) {
        await ref.invoke({by: 1}, {requestId: `r${n}`});
      }

      const delivered: CommittedActorEvent[] = [];
      const resumed = runtime('cursor');
      const off = resumed.subscribe(event => void delivered.push(event), {
        // The consumer owns its cursor; it already handled seq 0 and 1.
        since: () => 1,
      });
      try {
        await ref.invoke({by: 1}, {requestId: 'r3'});
        await waitFor(
          () => delivered.length >= 2,
          () => `delivered=${delivered.map(eventKey).join(',')}`,
        );
        expect(delivered.map(event => event.seq)).toEqual([2, 3]);
      } finally {
        off();
        await resumed.stopDelivery();
      }
    });

    it('indexes the identity before every commit, never memoized', async () => {
      // The load-bearing property of the discovery index is an *ordering*:
      // the SADD resolves before the commit script is issued, so a committed
      // event's identity is always discoverable. Nothing else in this file
      // fails if the SADD moves below the EVAL, so pin it here — recording
      // the SADD when it RESOLVES and the commit EVAL when it is ISSUED,
      // which is the strict form of "before".
      const trace: string[] = [];
      const base = new Proxy(connections.base, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== 'function') return value;
          const fn = value as (...args: unknown[]) => Promise<unknown>;
          if (property === 'sadd') {
            return async (...args: unknown[]) => {
              const result = await fn.apply(target, args);
              trace.push('sadd:resolved');
              return result;
            };
          }
          if (property === 'eval') {
            return (...args: unknown[]) => {
              // The commit script is the only one that appends to the log.
              if (String(args[0]).includes('XADD')) trace.push('commit:issued');
              return fn.apply(target, args);
            };
          }
          return fn.bind(target);
        },
      });
      const traced = new RedisActorRuntime(
        {
          base,
          duplicate: (...args: never[]) => connections.duplicate(...args),
          release: (conn: never) => connections.release(conn),
        } as unknown as RedisConnectionManager,
        {prefix: `${testPrefix}:ordering`, leaseMs: 1_000, leaseRetryMs: 5},
      );
      const definition = journal();
      traced.register(definition);

      await traced.ref(definition, 'o').invoke({by: 1}, {requestId: 'r0'});
      await traced.ref(definition, 'o').invoke({by: 1}, {requestId: 'r1'});

      expect(trace).toEqual([
        'sadd:resolved',
        'commit:issued',
        // Re-asserted on the second turn of the same identity: no per-process
        // memo, so an index entry lost after the first turn self-heals.
        'sadd:resolved',
        'commit:issued',
      ]);
      expect(
        await connections.base.smembers(`${testPrefix}:ordering:identities`),
      ).toEqual([`${encodeURIComponent(TYPE)}:o`]);
    });

    /**
     * One application with one `seat.journal.consumer` provider, on a shared
     * prefix — two of these in sequence model a process restart, which is the
     * only way to prove a cursor outlived the process that wrote it.
     */
    async function bootHost(
      prefix: string,
      provider: string,
      seen: string[],
      overrides: Partial<RedisActorRuntimeOptions> = {},
    ): Promise<Application> {
      const app = new Application();
      installRedisActors(app, {
        connections,
        prefix: `${testPrefix}:${prefix}`,
        leaseMs: 1_000,
        leaseRetryMs: 5,
        acquireTimeoutMs: 2_000,
        blockMs: 50,
        discoveryIntervalMs: 20,
        ...overrides,
      });
      app.add(
        Binding.bind(`consumers.${provider}`)
          .to({
            provider,
            consume: (event: CommittedActorEvent) => {
              seen.push(eventKey(event));
            },
          })
          .apply(extensionFor(SEAT_JOURNAL_CONSUMER)),
      );
      await app.start();
      return app;
    }

    it('resumes a DI consumer from its persisted cursor after a restart', async () => {
      // Without a persisted cursor every boot replays every identity's whole
      // history to every consumer — fine for an idempotent projection, ruinous
      // for one that fans out (webhooks, indexing) on a log that has grown.
      const rt = runtime('cursor-ep');
      const definition = journal();
      rt.register(definition);
      const ref = rt.ref(definition, 'p');

      const first: string[] = [];
      const before = await bootHost('cursor-ep', 'projection', first);
      await ref.invoke({by: 1}, {requestId: 'r0'});
      await ref.invoke({by: 1}, {requestId: 'r1'});
      await waitFor(
        () => first.length >= 2,
        () => `first=${first.join(',')}`,
      );
      await before.stop();

      // The journal keeps growing while nothing is listening.
      await ref.invoke({by: 1}, {requestId: 'r2'});
      await ref.invoke({by: 1}, {requestId: 'r3'});

      const second: string[] = [];
      const after = await bootHost('cursor-ep', 'projection', second);
      try {
        await waitFor(
          () => second.length >= 2,
          () => `second=${second.join(',')}`,
        );
        // Only what it had not already handled — the first two are not
        // replayed, even though they are still in the durable log.
        expect([...new Set(second)].sort()).toEqual([
          `${TYPE}/p#2`,
          `${TYPE}/p#3`,
        ]);
      } finally {
        await after.stop();
        await rt.stopDelivery();
      }
    });

    it('replays from the start for a consumer id the store has never seen', async () => {
      // Today's behavior is the default for a new consumer: no cursor means
      // the whole retained log, so a projection added later backfills itself.
      const rt = runtime('cursor-new');
      const definition = journal();
      rt.register(definition);
      const ref = rt.ref(definition, 'n');
      await ref.invoke({by: 1}, {requestId: 'r0'});
      await ref.invoke({by: 1}, {requestId: 'r1'});

      const known: string[] = [];
      const first = await bootHost('cursor-new', 'known', known);
      await waitFor(
        () => known.length >= 2,
        () => `known=${known.join(',')}`,
      );
      await first.stop();

      const fresh: string[] = [];
      const second = await bootHost('cursor-new', 'newcomer', fresh);
      try {
        await waitFor(
          () => fresh.length >= 2,
          () => `fresh=${fresh.join(',')}`,
        );
        expect([...new Set(fresh)].sort()).toEqual([
          `${TYPE}/n#0`,
          `${TYPE}/n#1`,
        ]);
      } finally {
        await second.stop();
        await rt.stopDelivery();
      }
    });

    it('logs the gap and continues when retention outran a persisted cursor', async () => {
      // Retention + a persisted cursor is the one combination that produces a
      // hole the consumer contract cannot paper over: the events between the
      // cursor and the oldest retained entry are simply gone. The host must
      // say so and keep going — never throw, never stall the tail.
      const retention = {journal: {maxEventsPerIdentity: 2}};
      const rt = runtime('cursor-gap', retention);
      const definition = journal();
      rt.register(definition);
      const ref = rt.ref(definition, 'g');

      const early: string[] = [];
      const before = await bootHost('cursor-gap', 'gappy', early, retention);
      await ref.invoke({by: 1}, {requestId: 'r0'});
      await waitFor(
        () => early.length >= 1,
        () => `early=${early.join(',')}`,
      );
      await before.stop();

      // Four more turns against a cap of two: seq 0 and 1 are trimmed away,
      // so the cursor at seq 0 can never be caught up from the log.
      for (const n of [1, 2, 3, 4]) {
        await ref.invoke({by: 1}, {requestId: `r${n}`});
      }
      expect((await rt.events(TYPE, 'g')).map(e => e.seq)).toEqual([3, 4]);

      enableDebug('agentback:actors:redis:delivery:*');
      const warnings: string[] = [];
      const disposeLog = onLog((namespace, level, args) => {
        if (
          namespace.startsWith('agentback:actors:redis:delivery') &&
          level === LogLevel.WARN
        ) {
          warnings.push(args.join(' '));
        }
      });
      const late: string[] = [];
      const after = await bootHost('cursor-gap', 'gappy', late, retention);
      try {
        await waitFor(
          () => late.length >= 2,
          () => `late=${late.join(',')}`,
        );
        // It continues from the oldest entry that still exists.
        expect([...new Set(late)].sort()).toEqual([
          `${TYPE}/g#3`,
          `${TYPE}/g#4`,
        ]);
        // `onLog` hands over the raw format string and args, uninterpolated.
        expect(
          warnings.some(
            line =>
              line.includes('gappy') &&
              line.includes(TYPE) &&
              line.includes('no longer in the log'),
          ),
        ).toBe(true);
      } finally {
        disposeLog();
        await after.stop();
        await rt.stopDelivery();
      }
    });

    it('does not call a throwing consumer a retention gap', async () => {
      // A consumer whose handler throws leaves its cursor behind while the log
      // moves on, which looks exactly like a cursor retention outran — except
      // the events are still in the log and will be replayed. Warning there
      // would point an operator at data loss that has not happened.
      const rt = runtime('gap-false-positive');
      const definition = journal();
      rt.register(definition);

      enableDebug('agentback:actors:redis:delivery:*');
      const warnings: string[] = [];
      const disposeLog = onLog((namespace, level, args) => {
        if (
          namespace.startsWith('agentback:actors:redis:delivery') &&
          level === LogLevel.WARN
        ) {
          warnings.push(args.join(' '));
        }
      });

      const app = new Application();
      let calls = 0;
      installRedisActors(app, {
        connections,
        prefix: `${testPrefix}:gap-false-positive`,
        leaseMs: 1_000,
        leaseRetryMs: 5,
        acquireTimeoutMs: 2_000,
        blockMs: 50,
        discoveryIntervalMs: 20,
      });
      app.add(
        Binding.bind('consumers.always-throws')
          .to({
            provider: 'always-throws',
            consume: () => {
              calls++;
              throw new Error('consumer boom');
            },
          })
          .apply(extensionFor(SEAT_JOURNAL_CONSUMER)),
      );
      await app.start();
      try {
        const ref = rt.ref(definition, 'f');
        for (const n of [0, 1, 2]) {
          await ref.invoke({by: 1}, {requestId: `r${n}`});
        }
        await waitFor(
          () => calls >= 3,
          () => `calls=${calls}`,
        );
        expect(warnings).toEqual([]);
      } finally {
        disposeLog();
        await app.stop();
        await rt.stopDelivery();
      }
    });

    it('rejects a delivery interval that would spin or block forever', () => {
      for (const options of [{blockMs: 0}, {discoveryIntervalMs: -1}]) {
        expect(() => runtime('bad', options)).toThrow(
          /must be a positive finite number/,
        );
      }
    });

    it('keeps tailing when a subscriber throws', async () => {
      const rt = runtime('throwing');
      const definition = journal();
      rt.register(definition);
      const survivors: number[] = [];
      const offThrowing = rt.subscribe(() => {
        throw new Error('subscriber boom');
      });
      const offGood = rt.subscribe(event => void survivors.push(event.seq));
      try {
        await rt.ref(definition, 't').invoke({by: 1}, {requestId: 'r0'});
        await rt.ref(definition, 't').invoke({by: 1}, {requestId: 'r1'});
        await waitFor(
          () => survivors.length >= 2,
          () => `survivors=${survivors.join(',')}`,
        );
        expect(survivors).toEqual([0, 1]);
      } finally {
        offThrowing();
        offGood();
        await rt.stopDelivery();
      }
    });

    it('serves registry.subscribe() and dispatches to seat.journal.consumer providers', async () => {
      const app = new Application();
      const consumed: string[] = [];
      let throwingCalls = 0;
      installRedisActors(app, {
        connections,
        prefix: `${testPrefix}:ep`,
        leaseMs: 1_000,
        leaseRetryMs: 5,
        acquireTimeoutMs: 2_000,
        blockMs: 50,
        discoveryIntervalMs: 20,
      });
      app.add(
        Binding.bind('consumers.good')
          .to({
            provider: 'good',
            consume: (event: CommittedActorEvent) => {
              consumed.push(eventKey(event));
            },
          })
          .apply(extensionFor(SEAT_JOURNAL_CONSUMER)),
      );
      // Rejected at registration: `consume` is not a function.
      app.add(
        Binding.bind('consumers.broken')
          .to({provider: 'broken', consume: 'nope'})
          .apply(extensionFor(SEAT_JOURNAL_CONSUMER)),
      );
      // Validated, but throws every time: degrades to skip + log.
      app.add(
        Binding.bind('consumers.throws')
          .to({
            provider: 'throws',
            consume: () => {
              throwingCalls++;
              throw new Error('consumer boom');
            },
          })
          .apply(extensionFor(SEAT_JOURNAL_CONSUMER)),
      );
      // `log.error(...)` is a no-op unless its namespace is enabled.
      enableDebug('agentback:actors:extensions:*');
      const skipped: string[] = [];
      const disposeLog = onLog((namespace, level, args) => {
        if (namespace.startsWith('agentback:actors:extensions')) {
          expect(level).toBe(LogLevel.ERROR);
          skipped.push(args.join(' '));
        }
      });
      await app.start();

      const rt = await app.get(ACTOR_RUNTIME);
      const definition = journal();
      rt.register(definition);
      const programmatic: string[] = [];
      const registry = await app.get(ACTOR_REGISTRY);
      const off = registry.subscribe(
        event => void programmatic.push(eventKey(event)),
      );

      await rt.ref(definition, 'ep').invoke({by: 1}, {requestId: 'r0'});
      await rt.ref(definition, 'ep').invoke({by: 1}, {requestId: 'r1'});

      // The throwing sibling is waited for too: it is dispatched *after* the
      // good one, so waiting only on `consumed` can observe the moment
      // between the two and assert on a count that has not happened yet.
      await waitFor(
        () =>
          consumed.length >= 2 &&
          programmatic.length >= 2 &&
          throwingCalls >= 2,
        () =>
          `consumed=${consumed.join(',')} programmatic=${programmatic.join(',')} throwing=${throwingCalls}`,
      );
      expect([...new Set(consumed)].sort()).toEqual([
        `${TYPE}/ep#0`,
        `${TYPE}/ep#1`,
      ]);
      // The throwing sibling ran and was skipped; the good one kept receiving.
      expect(throwingCalls).toBeGreaterThanOrEqual(2);
      expect([...new Set(programmatic)].sort()).toEqual([
        `${TYPE}/ep#0`,
        `${TYPE}/ep#1`,
      ]);
      // Both degrade paths are visible in the log, not swallowed.
      expect(
        skipped.some(
          line =>
            line.includes('consumers.broken') &&
            line.includes('rejected at registration'),
        ),
      ).toBe(true);
      expect(
        skipped.some(
          line => line.includes('throws') && line.includes('threw at runtime'),
        ),
      ).toBe(true);
      disposeLog();
      off();
      await app.stop();
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
