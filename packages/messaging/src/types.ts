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
    | 'waiting'
    | 'delayed'
    | 'active'
    | 'completed'
    | 'failed'
    | 'unknown';
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
