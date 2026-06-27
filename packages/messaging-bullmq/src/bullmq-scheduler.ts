// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  JobRef,
  QueueDescriptor,
  Scheduler,
} from '@agentback/messaging';
import type {BullMQJobQueue} from './bullmq-job-queue.js';
import {wrapJobData} from './bullmq-job-queue.js';

/**
 * Scheduler over BullMQ Job Schedulers (`upsertJobScheduler`), keyed by
 * `when.key` — re-scheduling the same key updates the cadence in place.
 */
export class BullMQScheduler implements Scheduler {
  constructor(private jobQueue: BullMQJobQueue) {}

  async schedule<T>(
    q: QueueDescriptor<T>,
    data: T,
    when: {cron?: string; everyMs?: number; key: string},
  ): Promise<JobRef> {
    const parsed = q.schema.parse(data);
    const job = await this.jobQueue
      .queueFor(q.name)
      .upsertJobScheduler(
        when.key,
        {pattern: when.cron, every: when.everyMs},
        {name: q.name, data: wrapJobData(parsed)},
      );
    return {id: job?.id ?? `scheduler:${when.key}`, queue: q.name};
  }

  async unschedule(q: QueueDescriptor<unknown>, key: string): Promise<boolean> {
    return this.jobQueue.queueFor(q.name).removeJobScheduler(key);
  }
}
