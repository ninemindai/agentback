// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {defineQueue, defineTopic} from '../descriptors.js';
import type {EventBus, JobQueue, QueueAdmin} from '../ports.js';

const tick = (ms = 30) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Poll an assertion until it passes or the timeout elapses. The last
 * assertion error is rethrown on timeout so failures stay readable.
 */
export async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 5000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise<void>(r => setTimeout(r, intervalMs));
    }
  }
}

/**
 * Adapter-supplied knobs for the conformance suites. Defaults match the
 * in-memory adapter, which therefore passes with no options at all.
 */
export interface ConformanceOptions {
  /**
   * Quiescence window for negative assertions ("nothing else happened").
   * Default is a 30ms tick — enough for the in-memory adapter. Networked
   * adapters (BullMQ/Redis) should pass a few hundred milliseconds.
   */
  settle?: () => Promise<void>;
  capabilities?: {
    /**
     * Whether `discardStalled` can synchronously discard an ACTIVE job whose
     * lock is still held (in-memory: yes — default true). BullMQ force-fails
     * lock-EXPIRED jobs only, so its suite opts out and covers the
     * lock-expiry path in adapter-specific tests.
     */
    syncDiscardActive?: boolean;
  };
}

/**
 * Behavioral contract every JobQueue adapter must satisfy. The in-memory
 * adapter runs this in Layer 1; the BullMQ adapter reuses it in Layer 2
 * (imported via `@agentback/messaging/testing`). Assertions
 * poll-with-timeout (`waitFor`) so the suite is not coupled to any
 * adapter's internal tick cadence.
 */
export function runJobQueueConformance(
  name: string,
  makeQueue: () => JobQueue,
  options: ConformanceOptions = {},
): void {
  const settle = options.settle ?? (() => tick());

  describe(`JobQueue conformance: ${name}`, () => {
    const Q = defineQueue('conformance.jobs', z.object({n: z.number()}));

    it('runs an enqueued job with decoded data', async () => {
      const q = makeQueue();
      const seen: number[] = [];
      const sub = q.process(Q, async job => {
        seen.push(job.data.n);
      });
      await q.enqueue(Q, {n: 7});
      await waitFor(() => expect(seen).toEqual([7]));
      await sub.close();
    });

    it('dedupes by jobId', async () => {
      const q = makeQueue();
      let count = 0;
      const sub = q.process(Q, async () => {
        count++;
      });
      await q.enqueue(Q, {n: 1}, {jobId: 'dup'});
      await q.enqueue(Q, {n: 1}, {jobId: 'dup'});
      await waitFor(() => expect(count).toBe(1));
      await settle();
      expect(count).toBe(1);
      await sub.close();
    });

    it('retries up to attempts then fails', async () => {
      const q = makeQueue();
      let attempts = 0;
      const sub = q.process(Q, async () => {
        attempts++;
        throw new Error('boom');
      });
      const ref = await q.enqueue(Q, {n: 1}, {attempts: 3});
      await waitFor(async () => {
        expect(attempts).toBe(3);
        const info = await q.get(Q, ref.id);
        expect(info?.state).toBe('failed');
      });
      await sub.close();
    });

    it('removeOnComplete removes the finished job', async () => {
      const q = makeQueue();
      const sub = q.process(Q, async () => {});
      const ref = await q.enqueue(Q, {n: 1}, {removeOnComplete: true});
      await waitFor(async () => {
        expect(await q.get(Q, ref.id)).toBeUndefined();
      });
      await sub.close();
    });

    it('cancel removes a waiting (delayed) job before it runs', async () => {
      const q = makeQueue();
      let ran = false;
      const sub = q.process(Q, async () => {
        ran = true;
      });
      const ref = await q.enqueue(Q, {n: 1}, {delayMs: 10_000});
      const cancelled = await q.cancel(Q, ref.id);
      expect(cancelled).toBe(true);
      await settle();
      expect(ran).toBe(false);
      await sub.close();
    });

    it('round-trips enqueue meta to JobContext.meta and JobInfo.meta', async () => {
      const q = makeQueue();
      const seen: Array<Record<string, string>> = [];
      const sub = q.process(Q, async job => {
        seen.push(job.meta);
      });
      const ref = await q.enqueue(
        Q,
        {n: 1},
        {meta: {traceparent: '00-abc-def-01', tenant: 't1'}},
      );
      await waitFor(() =>
        expect(seen).toEqual([{traceparent: '00-abc-def-01', tenant: 't1'}]),
      );
      const info = await q.get(Q, ref.id);
      expect(info?.meta).toEqual({traceparent: '00-abc-def-01', tenant: 't1'});
      await sub.close();
    });

    it('absent enqueue meta yields {} on JobContext and JobInfo', async () => {
      const q = makeQueue();
      const seen: Array<Record<string, string>> = [];
      const sub = q.process(Q, async job => {
        seen.push(job.meta);
      });
      const ref = await q.enqueue(Q, {n: 2});
      await waitFor(() => expect(seen).toEqual([{}]));
      const info = await q.get(Q, ref.id);
      expect(info?.meta).toEqual({});
      await sub.close();
    });

    it('routes a decode failure to failed (poison), not a silent drop', async () => {
      const q = makeQueue();
      // Bypass producer-side validation to simulate corrupt/drifted payload.
      const Bad = {...Q, schema: z.any()} as typeof Q;
      let handlerRan = false;
      const sub = q.process(Q, async () => {
        handlerRan = true;
      });
      const ref = await q.enqueue(Bad, {wrong: true} as never, {attempts: 1});
      await waitFor(async () => {
        const info = await q.get(Q, ref.id);
        expect(info?.state).toBe('failed');
      });
      expect(handlerRan).toBe(false);
      await sub.close();
    });
  });
}

/** Behavioral contract every EventBus adapter must satisfy. */
export function runEventBusConformance(
  name: string,
  makeBus: () => EventBus,
  options: ConformanceOptions = {},
): void {
  const settle = options.settle ?? (() => tick());

  describe(`EventBus conformance: ${name}`, () => {
    const T = defineTopic('conformance.events', z.object({v: z.number()}));

    it('delivers a published event to a subscriber, decoded', async () => {
      const bus = makeBus();
      const got: number[] = [];
      const sub = bus.subscribe(T, 'g1', async e => {
        got.push(e.v);
      });
      await settle();
      await bus.publish(T, {v: 5});
      await waitFor(() => expect(got).toEqual([5]));
      await sub.close();
    });

    it('fans out to independent groups (each group sees all events)', async () => {
      const bus = makeBus();
      const a: number[] = [];
      const b: number[] = [];
      const subA = bus.subscribe(T, 'A', async e => {
        a.push(e.v);
      });
      const subB = bus.subscribe(T, 'B', async e => {
        b.push(e.v);
      });
      await settle();
      await bus.publish(T, {v: 1});
      await bus.publish(T, {v: 2});
      await waitFor(() => {
        expect(a).toEqual([1, 2]);
        expect(b).toEqual([1, 2]);
      });
      await subA.close();
      await subB.close();
    });

    it('increments deliveryCount on redelivery after a throw', async () => {
      const bus = makeBus();
      const counts: number[] = [];
      let fail = true;
      const sub = bus.subscribe(T, 'g', async (_e, msg) => {
        counts.push(msg.deliveryCount);
        if (fail) {
          fail = false;
          throw new Error('retry me');
        }
      });
      await settle();
      await bus.publish(T, {v: 9});
      await waitFor(() => {
        expect(counts[0]).toBe(1);
        expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(2);
      });
      await sub.close();
    });

    it('round-trips publish meta to MsgMeta.meta; absent meta yields {}', async () => {
      const bus = makeBus();
      const seen: Array<Record<string, string>> = [];
      const sub = bus.subscribe(T, 'meta-g', async (_e, msg) => {
        seen.push(msg.meta);
      });
      await settle();
      await bus.publish(T, {v: 1}, {meta: {traceparent: '00-abc-def-01'}});
      await bus.publish(T, {v: 2});
      await waitFor(() =>
        expect(seen).toEqual([{traceparent: '00-abc-def-01'}, {}]),
      );
      await sub.close();
    });

    it('fromStart replays history; default reads only new events', async () => {
      const bus = makeBus();
      await bus.publish(T, {v: 100});
      await settle();

      const replayed: number[] = [];
      const sub = bus.subscribe(
        T,
        'late',
        async e => {
          replayed.push(e.v);
        },
        {fromStart: true},
      );

      const fresh: number[] = [];
      const defaultSub = bus.subscribe(T, 'default', async e => {
        fresh.push(e.v);
      });

      await waitFor(() => expect(replayed).toEqual([100]));
      await settle();
      // A default (no fromStart) subscriber must NOT replay history.
      expect(fresh).toEqual([]);
      await sub.close();
      await defaultSub.close();
    });
  });
}

/**
 * Behavioral contract for QueueAdmin. `makePair` returns an admin plus a way
 * to enqueue into the same backing store, so the suite stays adapter-neutral.
 */
export function runQueueAdminConformance(
  name: string,
  makePair: () => {
    admin: QueueAdmin;
    queue: JobQueue;
  },
  options: ConformanceOptions = {},
): void {
  const settle = options.settle ?? (() => tick());
  const syncDiscardActive = options.capabilities?.syncDiscardActive ?? true;

  describe(`QueueAdmin conformance: ${name}`, () => {
    const Q = defineQueue('conformance.admin', z.object({n: z.number()}));

    it('reports waiting count in stats', async () => {
      const {admin, queue} = makePair();
      await queue.enqueue(Q, {n: 1});
      await queue.enqueue(Q, {n: 2});
      await waitFor(async () => {
        expect((await admin.stats(Q)).waiting).toBe(2);
      });
    });

    it('drain clears the queue', async () => {
      const {admin, queue} = makePair();
      await queue.enqueue(Q, {n: 1});
      await admin.drain(Q);
      const stats = await admin.stats(Q);
      expect(stats.waiting).toBe(0);
    });

    it('pause stops processing; resume restarts it', async () => {
      const {admin, queue} = makePair();
      const ran: number[] = [];
      await admin.pause(Q);
      const sub = queue.process(Q, async job => {
        ran.push(job.data.n);
      });
      await queue.enqueue(Q, {n: 7});
      await settle();
      expect(ran).toEqual([]);
      await admin.resume(Q);
      await waitFor(() => expect(ran).toEqual([7]));
      await sub.close();
    });

    it('stats counts completed jobs', async () => {
      const {admin, queue} = makePair();
      const sub = queue.process(Q, async () => {});
      await queue.enqueue(Q, {n: 1});
      await waitFor(async () => {
        expect((await admin.stats(Q)).completed).toBe(1);
      });
      await sub.close();
    });

    // Requires the adapter to discard an active, lock-held job synchronously.
    // BullMQ can only force-fail lock-EXPIRED jobs, so it opts out via
    // capabilities.syncDiscardActive and tests the lock-expiry path itself.
    it.runIf(syncDiscardActive)(
      'discardStalled removes stuck active jobs (dryRun aware)',
      async () => {
        const {admin, queue} = makePair();
        let release: (() => void) | undefined;
        const gate = new Promise<void>(r => {
          release = r;
        });
        const sub = queue.process(Q, async () => {
          await gate;
        });
        await queue.enqueue(Q, {n: 1});
        // Job is now active and blocked on the gate.
        await waitFor(async () => {
          expect((await admin.stats(Q)).active).toBe(1);
        });

        // Ensure the job's startedAt is strictly older than the cutoff
        // (waitFor can observe the active state within the same millisecond).
        await tick(5);

        // cutoff = now; the job started a moment ago, so it counts as stalled.
        const dry = await admin.discardStalled(Q, 0, {dryRun: true});
        expect(dry).toBe(1);
        expect((await admin.stats(Q)).active).toBe(1); // dryRun: not removed

        const removed = await admin.discardStalled(Q, 0);
        expect(removed).toBe(1);
        expect((await admin.stats(Q)).active).toBe(0);

        release?.();
        await sub.close();
      },
    );
  });
}
