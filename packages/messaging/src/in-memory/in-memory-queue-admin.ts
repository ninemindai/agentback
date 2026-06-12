// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {QueueDescriptor} from '../descriptors.js';
import type {QueueAdmin} from '../ports.js';
import type {QueueStats} from '../types.js';
import type {InMemoryStore, JobState} from './in-memory-store.js';

/** In-memory QueueAdmin over a shared InMemoryStore. */
export class InMemoryQueueAdmin implements QueueAdmin {
  constructor(private store: InMemoryStore) {}

  async stats(q: QueueDescriptor<unknown>): Promise<QueueStats> {
    const jobs = this.store.list(q.name);
    const count = (s: JobState) => jobs.filter(j => j.state === s).length;
    return {
      waiting: count('waiting'),
      active: count('active'),
      delayed: count('delayed'),
      completed: count('completed'),
      failed: count('failed'),
    };
  }

  async drain(q: QueueDescriptor<unknown>): Promise<void> {
    for (const j of [...this.store.list(q.name)]) {
      if (j.state === 'waiting' || j.state === 'delayed') {
        this.store.remove(q.name, j.id);
      }
    }
  }

  async pause(q: QueueDescriptor<unknown>): Promise<void> {
    this.store.paused.add(q.name);
  }

  async resume(q: QueueDescriptor<unknown>): Promise<void> {
    // The pump polls every 10ms, so no explicit wake is needed on resume.
    this.store.paused.delete(q.name);
  }

  async discardStalled(
    q: QueueDescriptor<unknown>,
    olderThanSecs: number,
    opts: {dryRun?: boolean} = {},
  ): Promise<number> {
    const cutoff = Date.now() - olderThanSecs * 1000;
    const stalled = this.store
      .list(q.name)
      .filter(
        j =>
          j.state === 'active' &&
          j.startedAt !== undefined &&
          j.startedAt < cutoff,
      );
    if (!opts.dryRun) {
      for (const j of stalled) this.store.remove(q.name, j.id);
    }
    return stalled.length;
  }
}
