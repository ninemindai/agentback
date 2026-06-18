// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {QueueDescriptor} from '../descriptors.js';
import type {JobQueue} from '../ports.js';
import type {
  EnqueueOptions,
  JobContext,
  JobInfo,
  JobRef,
  Subscription,
  WorkerOptions,
} from '../types.js';
import {InMemoryStore, type StoredJob} from './in-memory-store.js';

const {error: logError} = loggers('messaging:in-memory:job-queue');

function backoffDelay(
  backoff: EnqueueOptions['backoff'],
  attempt: number,
): number {
  if (!backoff) return 0;
  if (backoff.type === 'exponential') {
    return backoff.delayMs * Math.pow(2, attempt - 1);
  }
  return backoff.delayMs;
}

/** In-memory JobQueue adapter. Shares its store with InMemoryQueueAdmin. */
export class InMemoryJobQueue implements JobQueue {
  constructor(private store: InMemoryStore = new InMemoryStore()) {}

  /** Expose the store so a paired admin can be built over the same jobs. */
  get backingStore(): InMemoryStore {
    return this.store;
  }

  private wakers = new Map<string, () => void>();

  async enqueue<T>(
    q: QueueDescriptor<T>,
    data: T,
    opts: EnqueueOptions = {},
  ): Promise<JobRef> {
    const parsed = q.schema.parse(data);
    // L1 adapter: opts.repeat (everyMs/cron) and opts.priority are recorded
    // on the job but NOT acted on here — only delayMs schedules timing, and
    // selection is FIFO. Periodic repeatable firing and priority ordering are
    // Layer-2 (BullMQ) concerns. DefaultScheduler.schedule therefore records
    // repeat intent but does not produce recurring runs in L1.
    if (opts.jobId && this.store.seenJobIds.has(opts.jobId)) {
      return {id: opts.jobId, queue: q.name};
    }
    const id = opts.jobId ?? `job_${++this.store.counter}`;
    if (opts.jobId) this.store.seenJobIds.add(opts.jobId);
    const now = Date.now();
    const job: StoredJob = {
      id,
      queue: q.name,
      raw: parsed,
      attempt: 0,
      state: opts.delayMs ? 'delayed' : 'waiting',
      availableAt: now + (opts.delayMs ?? 0),
      enqueuedAt: now,
      opts,
    };
    this.store.list(q.name).push(job);
    this.store.byId.set(id, job);
    this.wakers.get(q.name)?.();
    return {id, queue: q.name};
  }

  process<T>(
    q: QueueDescriptor<T>,
    handler: (job: JobContext<T>) => Promise<void>,
    opts: WorkerOptions = {},
  ): Subscription {
    const concurrency = opts.concurrency ?? 1;
    let closed = false;
    let active = 0;
    let wake: (() => void) | undefined;
    // NOTE: one processor per queue name in this L1 adapter; a second process()
    // call for the same queue replaces the waker. Sufficient for tests/single-worker.
    this.wakers.set(q.name, () => wake?.());

    const runOne = (job: StoredJob): void => {
      job.startedAt = Date.now();
      job.state = 'active';
      active++;
      void (async () => {
        try {
          const data = q.schema.parse(job.raw) as T;
          await handler({
            id: job.id,
            data,
            attempt: job.attempt,
            enqueuedAt: job.enqueuedAt,
            meta: job.opts.meta ?? {},
            log: () => {},
          });
          job.state = 'completed';
          // L1 adapter honors only the boolean form; the {count,ageSecs} object
          // form is a BullMQ (Layer 2) concern and is treated as "keep".
          if (job.opts.removeOnComplete === true) {
            this.store.remove(q.name, job.id);
          }
        } catch (err) {
          job.attempt++;
          const max = job.opts.attempts ?? 1;
          if (job.attempt < max) {
            job.availableAt =
              Date.now() + backoffDelay(job.opts.backoff, job.attempt);
            job.state = 'waiting';
          } else {
            job.state = 'failed';
            logError('job %s failed permanently: %O', job.id, err);
            if (job.opts.removeOnFail === true)
              this.store.remove(q.name, job.id);
          }
        } finally {
          active--;
          wake?.();
        }
      })();
    };

    const pump = async (): Promise<void> => {
      while (!closed) {
        const now = Date.now();
        const ready = this.store
          .list(q.name)
          .find(
            j =>
              !this.store.paused.has(q.name) &&
              (j.state === 'waiting' || j.state === 'delayed') &&
              j.availableAt <= now,
          );
        if (ready && active < concurrency) {
          runOne(ready);
          continue;
        }
        await new Promise<void>(res => {
          wake = res;
          setTimeout(res, 10);
        });
      }
    };
    void pump();

    return {
      // Returns immediately; does not await in-flight jobs (L1 semantics).
      close: async () => {
        closed = true;
        this.wakers.delete(q.name);
        wake?.();
      },
    };
  }

  async get<T>(
    q: QueueDescriptor<T>,
    id: string,
  ): Promise<JobInfo<T> | undefined> {
    const job = this.store.byId.get(id);
    if (!job || job.queue !== q.name) return undefined;
    return {
      id: job.id,
      state: job.state,
      data: job.raw as T,
      attempt: job.attempt,
      meta: job.opts.meta ?? {},
    };
  }

  async cancel(q: QueueDescriptor<unknown>, id: string): Promise<boolean> {
    const job = this.store.byId.get(id);
    if (!job || job.queue !== q.name) return false;
    if (job.state === 'waiting' || job.state === 'delayed') {
      this.store.remove(q.name, id);
      return true;
    }
    return false;
  }
}
