// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {QueueDescriptor} from './descriptors.js';
import type {JobQueue, Scheduler} from './ports.js';
import type {JobRef} from './types.js';

/**
 * Adapter-agnostic Scheduler: cron/interval scheduling is expressed as a
 * repeatable JobQueue job. Works over any JobQueue adapter.
 */
export class DefaultScheduler implements Scheduler {
  constructor(private queue: JobQueue) {}

  async schedule<T>(
    q: QueueDescriptor<T>,
    data: T,
    when: {cron?: string; everyMs?: number; key: string},
  ): Promise<JobRef> {
    return this.queue.enqueue(q, data, {
      jobId: `repeat:${q.name}:${when.key}`,
      repeat: {cron: when.cron, everyMs: when.everyMs, key: when.key},
    });
  }

  async unschedule(q: QueueDescriptor<unknown>, key: string): Promise<boolean> {
    return this.queue.cancel(q, `repeat:${q.name}:${key}`);
  }
}
