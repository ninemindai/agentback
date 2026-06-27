// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {EnqueueOptions} from '../types.js';

export type JobState =
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed';

export interface StoredJob {
  id: string;
  queue: string;
  raw: unknown;
  attempt: number;
  state: JobState;
  availableAt: number;
  enqueuedAt: number;
  startedAt?: number;
  opts: EnqueueOptions;
}

/** Shared mutable store so JobQueue and QueueAdmin see the same jobs. */
export class InMemoryStore {
  counter = 0;
  jobs = new Map<string, StoredJob[]>();
  byId = new Map<string, StoredJob>();
  seenJobIds = new Set<string>();
  paused = new Set<string>();

  list(name: string): StoredJob[] {
    let l = this.jobs.get(name);
    if (!l) {
      l = [];
      this.jobs.set(name, l);
    }
    return l;
  }

  remove(name: string, id: string): void {
    const l = this.jobs.get(name);
    if (l)
      this.jobs.set(
        name,
        l.filter(j => j.id !== id),
      );
    this.byId.delete(id);
    // Clear any dedup key so a drained/cancelled jobId can be re-enqueued.
    this.seenJobIds.delete(id);
  }
}
