// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {CoreTags} from '@agentback/core';
import {
  defineQueue,
  defineTopic,
  EVENT_BUS,
  JOB_QUEUE,
  QUEUE_ADMIN,
  SCHEDULER,
} from '@agentback/messaging';
import {waitFor} from '@agentback/messaging/testing';
import type {Redis} from 'ioredis';
import {afterAll, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  BULLMQ_MESSAGING_OBSERVER_KEY,
  BullMQJobQueue,
  BullMQMessagingComponent,
  BullMQQueueAdmin,
  BullMQScheduler,
  RedisConnectionManager,
  RedisStreamsEventBus,
} from '../index.js';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  // Direct stream write: vitest swallows console.* from fully-skipped files.
  process.stderr.write(
    '[messaging-bullmq] REDIS_URL not set — skipping BullMQ adapter ' +
      'tests (export REDIS_URL=redis://localhost:6379 to run)\n',
  );
}

const runId = `lbamqa${Date.now().toString(36)}p${process.pid}`;
let seq = 0;

let manager: RedisConnectionManager | undefined;
const queues: BullMQJobQueue[] = [];
const buses: RedisStreamsEventBus[] = [];

function getManager(): RedisConnectionManager {
  manager ??= new RedisConnectionManager({url: REDIS_URL});
  return manager;
}

function makeQueue(): BullMQJobQueue {
  const queue = new BullMQJobQueue(getManager(), {
    prefix: `${runId}q${seq++}`,
  });
  queues.push(queue);
  return queue;
}

function makeBus(): {bus: RedisStreamsEventBus; prefix: string} {
  const prefix = `${runId}e${seq++}`;
  const bus = new RedisStreamsEventBus(getManager(), {
    prefix,
    blockMs: 250,
    reclaimMinIdleMs: 50,
    reclaimIntervalMs: 100,
  });
  buses.push(bus);
  return {bus, prefix};
}

const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const settle = () => tick(600);

async function deleteKeys(client: Redis, pattern: string): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    if (keys.length > 0) await client.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}

describe.skipIf(!REDIS_URL)('BullMQ adapter specifics (Redis)', () => {
  afterAll(async () => {
    await Promise.all(buses.map(b => b.close().catch(() => undefined)));
    await Promise.all(queues.map(q => q.close().catch(() => undefined)));
    if (manager) {
      await deleteKeys(manager.base, `${runId}*`);
      await manager.close();
    }
  });

  it('component rebinds the four ports + a lifecycle observer', async () => {
    const component = new BullMQMessagingComponent({
      connection: {url: REDIS_URL},
      prefix: `${runId}c`,
    });
    try {
      const keys = component.bindings.map(b => b.key);
      expect(keys).toContain(JOB_QUEUE.key);
      expect(keys).toContain(EVENT_BUS.key);
      expect(keys).toContain(QUEUE_ADMIN.key);
      expect(keys).toContain(SCHEDULER.key);
      expect(keys).toContain(BULLMQ_MESSAGING_OBSERVER_KEY);
      const observer = component.bindings.find(
        b => b.key === BULLMQ_MESSAGING_OBSERVER_KEY,
      );
      expect(observer?.tagNames).toContain(CoreTags.LIFE_CYCLE_OBSERVER);
    } finally {
      await component.jobQueue.close();
      await component.eventBus.close();
      await component.connections.close();
    }
  });

  it('rejects an enqueue whose payload fails the schema (never hits Redis)', async () => {
    const q = makeQueue();
    const Q = defineQueue('validated.jobs', z.object({n: z.number()}));
    await expect(q.enqueue(Q, {n: 'not-a-number'} as never)).rejects.toThrow();
    const admin = new BullMQQueueAdmin(q);
    expect((await admin.stats(Q)).waiting).toBe(0);
  });

  it('stores job data as a {$payload, $meta} envelope on the wire', async () => {
    const q = makeQueue();
    const Q = defineQueue('envelope.jobs', z.object({n: z.number()}));
    const ref = await q.enqueue(
      Q,
      {n: 1},
      {meta: {traceparent: '00-abc-def-01'}},
    );
    // Adapter-owned wire format: payload + transport meta, side by side.
    const raw = await q.queueFor(Q.name).getJob(ref.id);
    expect(raw?.data).toEqual({
      $payload: {n: 1},
      $meta: {traceparent: '00-abc-def-01'},
    });
    // Port-level reads unwrap the envelope transparently.
    const info = await q.get(Q, ref.id);
    expect(info?.data).toEqual({n: 1});
    expect(info?.meta).toEqual({traceparent: '00-abc-def-01'});
  });

  it('cancel refuses a completed job', async () => {
    const q = makeQueue();
    const Q = defineQueue('done.jobs', z.object({n: z.number()}));
    const sub = q.process(Q, async () => {});
    const ref = await q.enqueue(Q, {n: 1});
    await waitFor(async () => {
      expect((await q.get(Q, ref.id))?.state).toBe('completed');
    });
    expect(await q.cancel(Q, ref.id)).toBe(false);
    await sub.close();
  });

  it('scheduler upserts by key and unschedules', async () => {
    const q = makeQueue();
    const scheduler = new BullMQScheduler(q);
    const Q = defineQueue('sched.jobs', z.object({tag: z.string()}));
    const seen: string[] = [];
    const sub = q.process(Q, async job => {
      seen.push(job.data.tag);
    });

    await scheduler.schedule(Q, {tag: 'a'}, {everyMs: 200, key: 'tick'});
    await waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1));
    expect(seen[0]).toBe('a');

    // Re-scheduling the same key UPDATES in place (one scheduler, new data).
    await scheduler.schedule(Q, {tag: 'b'}, {everyMs: 200, key: 'tick'});
    await waitFor(() => expect(seen).toContain('b'));
    const schedulers = await q.queueFor(Q.name).getJobSchedulers();
    expect(schedulers).toHaveLength(1);

    expect(await scheduler.unschedule(Q, 'tick')).toBe(true);
    expect(await scheduler.unschedule(Q, 'tick')).toBe(false);
    await settle();
    const after = seen.length;
    await settle();
    expect(seen.length).toBe(after); // no iterations after unschedule
    await sub.close();
  });

  it('admin: stats reflect waiting/delayed; pause/resume gate work', async () => {
    const q = makeQueue();
    const admin = new BullMQQueueAdmin(q);
    const Q = defineQueue('admin.jobs', z.object({n: z.number()}));

    await q.enqueue(Q, {n: 1});
    await q.enqueue(Q, {n: 2}, {delayMs: 60_000});
    let stats = await admin.stats(Q);
    expect(stats.waiting).toBe(1);
    expect(stats.delayed).toBe(1);

    await admin.pause(Q);
    const ran: number[] = [];
    const sub = q.process(Q, async job => {
      ran.push(job.data.n);
    });
    await q.enqueue(Q, {n: 3});
    await settle();
    expect(ran).toEqual([]); // paused: nothing processed
    expect((await admin.stats(Q)).waiting).toBe(2); // paused jobs count

    await admin.resume(Q);
    await waitFor(() => expect(ran).toEqual([1, 3]));
    await waitFor(async () => {
      stats = await admin.stats(Q);
      expect(stats.completed).toBe(2);
      expect(stats.waiting).toBe(0);
    });
    await sub.close();
  });

  it('discardStalled force-fails lock-expired active jobs only', async () => {
    const q = makeQueue();
    const admin = new BullMQQueueAdmin(q);
    const Q = defineQueue('stalled.jobs', z.object({n: z.number()}));
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    // Short lock, renewal pushed past the test window — the lock expires
    // while the handler is still parked on the gate (a "dead" worker).
    const sub = q.process(Q, async () => gate, {
      lockDurationMs: 500,
      lockRenewMs: 60_000,
    });
    await q.enqueue(Q, {n: 1});
    await waitFor(async () => {
      expect((await admin.stats(Q)).active).toBe(1);
    });
    await tick(5); // ensure startedAt < cutoff

    // Lock still held → a live worker owns it → skipped.
    expect(await admin.discardStalled(Q, 0)).toBe(0);

    // Wait for the lock to expire.
    const queue = q.queueFor(Q.name);
    const [active] = await queue.getJobs(['active']);
    const lockKey = `${queue.toKey(active.id!)}:lock`;
    await waitFor(async () => {
      expect(await getManager().base.pttl(lockKey)).toBeLessThanOrEqual(0);
    });

    // dryRun counts without discarding.
    expect(await admin.discardStalled(Q, 0, {dryRun: true})).toBe(1);
    expect((await admin.stats(Q)).active).toBe(1);

    expect(await admin.discardStalled(Q, 0)).toBe(1);
    await waitFor(async () => {
      const stats = await admin.stats(Q);
      expect(stats.active).toBe(0);
      expect(stats.failed).toBe(1);
    });

    release();
    await sub.close();
  });

  it('event bus: two groups both receive; ack-on-resolve empties the PEL', async () => {
    const {bus, prefix} = makeBus();
    const T = defineTopic('orders.events', z.object({v: z.number()}));
    const a: number[] = [];
    const b: number[] = [];
    const subA = bus.subscribe(T, 'g1', async e => {
      a.push(e.v);
    });
    const subB = bus.subscribe(T, 'g2', async e => {
      b.push(e.v);
    });
    await settle(); // both groups exist before publishing

    await bus.publish(T, {v: 1});
    await bus.publish(T, {v: 2});
    await waitFor(() => {
      expect(a).toEqual([1, 2]);
      expect(b).toEqual([1, 2]);
    });

    // Handlers resolved → both messages XACKed → no pending entries left.
    const key = `${prefix}:${T.name}`;
    await waitFor(async () => {
      for (const group of ['g1', 'g2']) {
        const [pending] = (await getManager().base.xpending(key, group)) as [
          number,
          ...unknown[],
        ];
        expect(pending).toBe(0);
      }
    });

    await expect(bus.publish(T, {v: 'bad'} as never)).rejects.toThrow();
    await subA.close();
    await subB.close();
  });

  it('event bus stores meta in its own stream field beside the payload', async () => {
    const {bus, prefix} = makeBus();
    const T = defineTopic('meta.events', z.object({v: z.number()}));
    const seen: Array<Record<string, string>> = [];
    const sub = bus.subscribe(T, 'g', async (_e, msg) => {
      seen.push(msg.meta);
    });
    await settle();
    await bus.publish(T, {v: 1}, {meta: {traceparent: '00-abc-def-01'}});
    await waitFor(() => expect(seen).toEqual([{traceparent: '00-abc-def-01'}]));

    // XADD wrote `meta` as its own field — payload field is unchanged.
    const key = `${prefix}:${T.name}`;
    const [[, fields]] = (await getManager().base.xrange(
      key,
      '-',
      '+',
    )) as Array<[string, string[]]>;
    const map = new Map<string, string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      map.set(fields[i], fields[i + 1]);
    }
    expect(JSON.parse(map.get('payload')!)).toEqual({v: 1});
    expect(JSON.parse(map.get('meta')!)).toEqual({
      traceparent: '00-abc-def-01',
    });
    await sub.close();
  });
});
