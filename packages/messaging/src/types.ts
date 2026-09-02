// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/** Repeatable/cron options for an enqueued job. */
export interface RepeatOptions {
  cron?: string;
  everyMs?: number;
  key?: string;
  limit?: number;
}

/** Options controlling how a job is enqueued. */
export interface EnqueueOptions {
  /** Idempotency / dedup key. A repeat enqueue with the same id is a no-op. */
  jobId?: string;
  delayMs?: number;
  repeat?: RepeatOptions;
  /** Max attempts including the first (default 1 = no retry). */
  attempts?: number;
  backoff?: {type: 'fixed' | 'exponential'; delayMs: number};
  removeOnComplete?: boolean | {count?: number; ageSecs?: number};
  removeOnFail?: boolean | {count?: number};
  priority?: number;
  /**
   * Transport metadata envelope (e.g. W3C trace context). Travels beside the
   * payload and is NOT part of the validated payload — it is never run
   * through the queue's Zod schema. Delivered as {@link JobContext.meta}.
   */
  meta?: Record<string, string>;
}

/** Options for a worker registered via JobQueue.process(). */
export interface WorkerOptions {
  concurrency?: number;
  lockDurationMs?: number;
  lockRenewMs?: number;
  autorun?: boolean;
  /**
   * Wall-clock budget for one attempt, in ms. On elapse the attempt's
   * {@link JobContext.signal} aborts, the slot is freed, and the job fails
   * **terminally** — an abandoned attempt is never retried, because
   * redelivering a hang just buys the same hang on the next worker.
   *
   * No default: an unbounded handler keeps working exactly as before. Set one
   * on any queue whose handler calls a model or a third-party API — a retry
   * cap counts attempts, and a run stalled *inside* an attempt stops counting
   * while it keeps billing. A clock is the only thing that ends that.
   *
   * The handler is abandoned, not killed: Node cannot interrupt running code,
   * so a handler that ignores its signal runs on with nobody reading its
   * result. Honor the signal to actually stop the work.
   */
  timeoutMs?: number;
}

/** The decoded job handed to a processor. */
export interface JobContext<T> {
  readonly id: string;
  readonly data: T;
  /** 0-based redelivery count (mirrors BullMQ attemptsMade). */
  readonly attempt: number;
  readonly enqueuedAt: number;
  /** Transport metadata from {@link EnqueueOptions.meta} (`{}` if absent). */
  readonly meta: Record<string, string>;
  /**
   * Cancellation for this attempt. Aborts when {@link WorkerOptions.timeoutMs}
   * elapses or `JobQueue.cancel()` reaches this worker's process.
   *
   * Hand it to whatever spends time or money — it is the difference between a
   * cancelled job and a job nobody is waiting for that keeps billing:
   *
   * ```ts
   * queue.process(Forecasts, async job => {
   *   const res = await fetch(url, {signal: job.signal});
   * }, {timeoutMs: 900_000});
   * ```
   */
  readonly signal: AbortSignal;
  log(message: string): void;
}

/** Reference returned by enqueue/schedule. */
export interface JobRef {
  readonly id: string;
  readonly queue: string;
}

/** Snapshot of a job's state. */
export interface JobInfo<T = unknown> {
  readonly id: string;
  readonly state:
    'waiting' | 'delayed' | 'active' | 'completed' | 'failed' | 'unknown';
  readonly data?: T;
  readonly attempt: number;
  /** Transport metadata from {@link EnqueueOptions.meta} (`{}` if absent). */
  readonly meta: Record<string, string>;
}

/** A closeable registration (worker or subscriber). */
export interface Subscription {
  close(): Promise<void>;
}

/** Metadata accompanying a delivered event. */
export interface MsgMeta {
  readonly id: string;
  readonly topic: string;
  readonly group: string;
  /** 1-based delivery attempt for this message to this group. */
  readonly deliveryCount: number;
  readonly publishedAt: number;
  /** Transport metadata from {@link PublishOptions.meta} (`{}` if absent). */
  readonly meta: Record<string, string>;
}

/** Options controlling how an event is published. */
export interface PublishOptions {
  /**
   * Transport metadata envelope (e.g. W3C trace context). Travels beside the
   * payload and is NOT part of the validated payload — it is never run
   * through the topic's Zod schema. Delivered as {@link MsgMeta.meta}.
   */
  meta?: Record<string, string>;
}

/** Options for an EventBus subscription. */
export interface SubscribeOptions {
  concurrency?: number;
  /** Read history from the start vs only events published after subscribe. */
  fromStart?: boolean;
}

/** Aggregate queue counters. */
export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
}
