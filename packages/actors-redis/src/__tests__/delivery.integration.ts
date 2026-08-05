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
import {RedisActorRuntime} from '../redis-actor-runtime.js';
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
  const runtime = (suffix: string) =>
    new RedisActorRuntime(connections, {
      prefix: `${testPrefix}:${suffix}`,
      leaseMs: 1_000,
      leaseRetryMs: 5,
      acquireTimeoutMs: 2_000,
      dedupTtlSeconds: 60,
      blockMs: 50,
      discoveryIntervalMs: 20,
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

      await waitFor(
        () => consumed.length >= 2 && programmatic.length >= 2,
        () =>
          `consumed=${consumed.join(',')} programmatic=${programmatic.join(',')}`,
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
