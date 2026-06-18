// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  runEventBusConformance,
  runJobQueueConformance,
  runQueueAdminConformance,
} from '@agentback/messaging/testing';
import type {Redis} from 'ioredis';
import {afterAll, describe} from 'vitest';
import {
  BullMQJobQueue,
  BullMQQueueAdmin,
  RedisConnectionManager,
  RedisStreamsEventBus,
} from '../index.js';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  // Direct stream write: vitest swallows console.* from fully-skipped files.
  process.stderr.write(
    '[messaging-bullmq] REDIS_URL not set — skipping BullMQ/Redis ' +
      'conformance tests (export REDIS_URL=redis://localhost:6379 to run)\n',
  );
}

// Unique per-run key prefix: isolates from previous runs against the same
// Redis (BullMQ jobId dedup and stream history are durable) and lets the
// afterAll hook clean up everything this run created.
const runId = `lbamq${Date.now().toString(36)}p${process.pid}`;
let seq = 0;

// Created lazily inside test bodies so a skipped suite never opens a
// connection (ioredis connects eagerly and would retry forever).
let manager: RedisConnectionManager | undefined;
const queues: BullMQJobQueue[] = [];
const buses: RedisStreamsEventBus[] = [];

function getManager(): RedisConnectionManager {
  manager ??= new RedisConnectionManager({url: REDIS_URL});
  return manager;
}

/** Each conformance test gets its own BullMQ key prefix (state isolation). */
function makeQueue(): BullMQJobQueue {
  const queue = new BullMQJobQueue(getManager(), {
    prefix: `${runId}q${seq++}`,
  });
  queues.push(queue);
  return queue;
}

/** Each conformance test gets its own stream prefix + fast reclaim tuning. */
function makeBus(): RedisStreamsEventBus {
  const bus = new RedisStreamsEventBus(getManager(), {
    prefix: `${runId}e${seq++}`,
    blockMs: 250,
    // The deliveryCount conformance case needs redelivery well inside the
    // test timeout; production defaults (30s/15s) are deliberately not used.
    reclaimMinIdleMs: 50,
    reclaimIntervalMs: 100,
  });
  buses.push(bus);
  return bus;
}

// Quiescence window for negative assertions — generous enough for worker
// startup + a network round trip.
const settle = () => new Promise<void>(r => setTimeout(r, 600));

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

describe.skipIf(!REDIS_URL)('messaging-bullmq conformance (Redis)', () => {
  runJobQueueConformance('bullmq', makeQueue, {settle});

  runEventBusConformance('redis-streams', makeBus, {settle});

  runQueueAdminConformance(
    'bullmq',
    () => {
      const queue = makeQueue();
      return {queue, admin: new BullMQQueueAdmin(queue)};
    },
    {
      settle,
      // BullMQ can only force-fail lock-EXPIRED active jobs; the lock-expiry
      // path is covered in bullmq-adapter.integration.ts.
      capabilities: {syncDiscardActive: false},
    },
  );

  afterAll(async () => {
    await Promise.all(buses.map(b => b.close().catch(() => undefined)));
    await Promise.all(queues.map(q => q.close().catch(() => undefined)));
    if (manager) {
      await deleteKeys(manager.base, `${runId}*`);
      await manager.close();
    }
  });
});
