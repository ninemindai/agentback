// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {
  EnqueueOptions,
  JobInfo,
  JobQueue,
  JobRef,
  JobContext,
  QueueDescriptor,
  Subscription,
  WorkerOptions,
} from '@agentback/messaging';
import {
  Queue,
  UnrecoverableError,
  Worker,
  type ConnectionOptions,
  type JobsOptions,
  type WorkerOptions as BullMQWorkerOptions,
} from 'bullmq';
import type {RedisConnectionManager} from './connection.js';

/**
 * bullmq pins its own ioredis minor, so its `ConnectionOptions` nominally
 * differs from the workspace ioredis `Redis` type. Runtime-compatible —
 * bridge the declaration skew at the boundary only.
 */
const asConnection = (conn: unknown): ConnectionOptions =>
  conn as ConnectionOptions;

const {error: logError, debug} = loggers('messaging:bullmq:job-queue');

export interface BullMQJobQueueOptions {
  /** BullMQ key prefix (default `bull`). */
  prefix?: string;
}

/**
 * BullMQ job-data envelope. This adapter owns its wire format: every job is
 * stored as `{$payload, $meta}` so transport metadata (e.g. W3C trace
 * context from `EnqueueOptions.meta`) travels beside the payload without
 * touching the validated payload itself. Pre-release format change — on
 * read, a bare (pre-envelope) payload is tolerated and treated as
 * `$payload` with empty meta; consumer-side schema validation still applies.
 */
export interface BullMQJobData {
  $payload: unknown;
  $meta: Record<string, string>;
}

/** Wrap a validated payload + meta into the BullMQ job-data envelope. */
export function wrapJobData(
  payload: unknown,
  meta: Record<string, string> = {},
): BullMQJobData {
  return {$payload: payload, $meta: meta};
}

/** Unwrap the BullMQ job-data envelope (tolerates a malformed read). */
export function unwrapJobData(data: unknown): {
  payload: unknown;
  meta: Record<string, string>;
} {
  if (typeof data === 'object' && data !== null && '$payload' in data) {
    const envelope = data as BullMQJobData;
    return {payload: envelope.$payload, meta: envelope.$meta ?? {}};
  }
  // Not an envelope (older producer / foreign writer): treat the raw data as
  // the payload — consumer-side schema validation decides its fate.
  return {payload: data, meta: {}};
}

/** Map port-level EnqueueOptions onto BullMQ JobsOptions. */
export function mapEnqueueOptions(opts: EnqueueOptions): JobsOptions {
  const out: JobsOptions = {};
  if (opts.jobId !== undefined) out.jobId = opts.jobId;
  if (opts.delayMs !== undefined) out.delay = opts.delayMs;
  if (opts.attempts !== undefined) out.attempts = opts.attempts;
  if (opts.backoff) {
    out.backoff = {type: opts.backoff.type, delay: opts.backoff.delayMs};
  }
  if (opts.priority !== undefined) out.priority = opts.priority;
  if (opts.removeOnComplete !== undefined) {
    out.removeOnComplete = mapKeep(opts.removeOnComplete);
  }
  if (opts.removeOnFail !== undefined) {
    out.removeOnFail = mapKeep(opts.removeOnFail);
  }
  if (opts.repeat) {
    // Legacy BullMQ repeat. Prefer BullMQScheduler (job schedulers) for
    // cron/interval work — it is keyed and upsertable.
    out.repeat = {
      pattern: opts.repeat.cron,
      every: opts.repeat.everyMs,
      limit: opts.repeat.limit,
      key: opts.repeat.key,
    };
  }
  return out;
}

/**
 * Map the port's keep/remove shape onto BullMQ's `number | boolean |
 * KeepJobs` (whose object form requires `age`). A bare `{count}` becomes the
 * numeric "keep last N" form; an empty object means plain removal.
 */
function mapKeep(
  keep: boolean | {count?: number; ageSecs?: number},
): JobsOptions['removeOnComplete'] {
  if (typeof keep === 'boolean') return keep;
  if (keep.ageSecs !== undefined) {
    return {age: keep.ageSecs, count: keep.count};
  }
  if (keep.count !== undefined) return keep.count;
  return true;
}

function mapJobState(state: string): JobInfo['state'] {
  switch (state) {
    case 'waiting':
    case 'waiting-children':
    case 'prioritized':
      return 'waiting';
    case 'delayed':
    case 'active':
    case 'completed':
    case 'failed':
      return state;
    default:
      return 'unknown';
  }
}

/**
 * Durable JobQueue over BullMQ. One BullMQ `Queue` per descriptor name,
 * lazily created over the shared base connection; one BullMQ `Worker` (on a
 * dedicated duplicated connection) per `process()` call.
 */
export class BullMQJobQueue implements JobQueue {
  private queues = new Map<string, Queue>();
  private workers = new Set<Worker>();

  constructor(
    readonly connections: RedisConnectionManager,
    private options: BullMQJobQueueOptions = {},
  ) {}

  /**
   * Lazily create/cache the BullMQ Queue for a name. Shared with
   * BullMQQueueAdmin and BullMQScheduler so all three operate on the same
   * Queue instances (and the lifecycle observer closes each one once).
   */
  queueFor(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: asConnection(this.connections.base),
        prefix: this.options.prefix,
      });
      this.queues.set(name, queue);
      debug('created queue %s', name);
    }
    return queue;
  }

  async enqueue<T>(
    q: QueueDescriptor<T>,
    data: T,
    opts: EnqueueOptions = {},
  ): Promise<JobRef> {
    // Producer-side validation: decode failures never reach Redis.
    const parsed = q.schema.parse(data);
    const job = await this.queueFor(q.name).add(
      q.name,
      wrapJobData(parsed, opts.meta),
      mapEnqueueOptions(opts),
    );
    return {id: job.id ?? opts.jobId ?? '', queue: q.name};
  }

  process<T>(
    q: QueueDescriptor<T>,
    handler: (job: JobContext<T>) => Promise<void>,
    opts: WorkerOptions = {},
  ): Subscription {
    // Each worker issues blocking commands — it gets its own connection.
    const conn = this.connections.duplicate();
    const workerOptions: BullMQWorkerOptions = {
      connection: asConnection(conn),
      prefix: this.options.prefix,
      concurrency: opts.concurrency ?? 1,
    };
    if (opts.lockDurationMs !== undefined) {
      workerOptions.lockDuration = opts.lockDurationMs;
    }
    if (opts.lockRenewMs !== undefined) {
      workerOptions.lockRenewTime = opts.lockRenewMs;
    }
    if (opts.autorun !== undefined) workerOptions.autorun = opts.autorun;

    const worker = new Worker(
      q.name,
      async job => {
        // Consumer-side re-validation: a payload written by an older or
        // corrupt producer must fail into `failed` (poison), not crash the
        // worker loop. UnrecoverableError skips BullMQ's retry path.
        const {payload, meta} = unwrapJobData(job.data);
        const decoded = q.schema.safeParse(payload);
        if (!decoded.success) {
          logError(
            'job %s on %s failed payload validation: %O',
            job.id,
            q.name,
            decoded.error,
          );
          throw new UnrecoverableError(
            `Payload for queue "${q.name}" failed schema validation: ${decoded.error.message}`,
          );
        }
        await handler({
          id: job.id ?? '',
          data: decoded.data,
          // BullMQ v5 increments attemptsMade after an attempt finishes, so
          // it is 0-based during processing — exactly JobContext.attempt.
          attempt: job.attemptsMade,
          enqueuedAt: job.timestamp,
          meta,
          log: message => void job.log(message).catch(() => {}),
        });
      },
      workerOptions,
    );
    worker.on('error', err => {
      logError('worker error on %s: %O', q.name, err);
    });
    this.workers.add(worker);

    return {
      close: async () => {
        this.workers.delete(worker);
        await worker.close();
        await this.connections.release(conn);
      },
    };
  }

  async get<T>(
    q: QueueDescriptor<T>,
    id: string,
  ): Promise<JobInfo<T> | undefined> {
    const job = await this.queueFor(q.name).getJob(id);
    if (!job) return undefined;
    const state = await job.getState();
    const {payload, meta} = unwrapJobData(job.data);
    return {
      id: job.id ?? id,
      state: mapJobState(state),
      data: payload as T,
      attempt: job.attemptsMade,
      meta,
    };
  }

  async cancel(q: QueueDescriptor<unknown>, id: string): Promise<boolean> {
    const job = await this.queueFor(q.name).getJob(id);
    if (!job) return false;
    const state = await job.getState();
    // Layer-1 parity: only not-yet-started jobs can be cancelled.
    if (state !== 'waiting' && state !== 'delayed' && state !== 'prioritized') {
      return false;
    }
    try {
      await job.remove();
      return true;
    } catch {
      // Raced into active (now locked) — treat as not cancellable.
      return false;
    }
  }

  /** Close workers first (graceful: waits for in-flight jobs), then queues. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.workers].map(w => w.close().catch(() => undefined)),
    );
    this.workers.clear();
    await Promise.all(
      [...this.queues.values()].map(qu => qu.close().catch(() => undefined)),
    );
    this.queues.clear();
  }
}
