// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {
  QueueAdmin,
  QueueDescriptor,
  QueueStats,
} from '@agentback/messaging';
import type {BullMQJobQueue} from './bullmq-job-queue.js';

const {warn} = loggers('messaging:bullmq:queue-admin');

/**
 * QueueAdmin over the same BullMQ Queue instances as BullMQJobQueue (shared
 * lazily-created cache, shared base connection).
 */
export class BullMQQueueAdmin implements QueueAdmin {
  constructor(private jobQueue: BullMQJobQueue) {}

  async stats(q: QueueDescriptor<unknown>): Promise<QueueStats> {
    const counts = await this.jobQueue
      .queueFor(q.name)
      .getJobCounts(
        'waiting',
        'paused',
        'prioritized',
        'active',
        'delayed',
        'completed',
        'failed',
      );
    return {
      // BullMQ reports paused/prioritized jobs separately; for the port they
      // are all "waiting to run".
      waiting:
        (counts.waiting ?? 0) +
        (counts.paused ?? 0) +
        (counts.prioritized ?? 0),
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
    };
  }

  async drain(q: QueueDescriptor<unknown>): Promise<void> {
    // true = also remove delayed jobs (parity with the in-memory adapter).
    await this.jobQueue.queueFor(q.name).drain(true);
  }

  async pause(q: QueueDescriptor<unknown>): Promise<void> {
    await this.jobQueue.queueFor(q.name).pause();
  }

  async resume(q: QueueDescriptor<unknown>): Promise<void> {
    await this.jobQueue.queueFor(q.name).resume();
  }

  /**
   * Force-fail stuck active jobs — lock-EXPIRED jobs only. A held lock means
   * a live worker still owns the job (BullMQ's stalled-checker handles
   * re-queueing those); this API permanently fails the truly abandoned ones.
   */
  async discardStalled(
    q: QueueDescriptor<unknown>,
    olderThanSecs: number,
    opts: {dryRun?: boolean} = {},
  ): Promise<number> {
    const queue = this.jobQueue.queueFor(q.name);
    // Use the shared base connection for the raw PTTL probe (bullmq's
    // `queue.client` is typed against its own pinned ioredis).
    const client = this.jobQueue.connections.base;
    const cutoff = Date.now() - olderThanSecs * 1000;
    const active = await queue.getJobs(['active']);
    let discarded = 0;
    for (const job of active) {
      if (!job.id) continue;
      const startedAt = job.processedOn ?? job.timestamp;
      if (startedAt >= cutoff) continue;
      // Lock still held (positive TTL) → a live worker owns it; skip.
      const lockTtl = await client.pttl(`${queue.toKey(job.id)}:lock`);
      if (lockTtl > 0) continue;
      discarded++;
      if (opts.dryRun) continue;
      try {
        // discard() suppresses BullMQ's retry path; token '0' skips the lock
        // check in moveToFinished — safe because we verified the lock is gone.
        job.discard();
        await job.moveToFailed(
          new Error(
            `Discarded as stalled by QueueAdmin.discardStalled ` +
              `(active longer than ${olderThanSecs}s with an expired lock)`,
          ),
          '0',
          false,
        );
      } catch (err) {
        warn('failed to discard stalled job %s on %s: %O', job.id, q.name, err);
        discarded--;
      }
    }
    return discarded;
  }
}
