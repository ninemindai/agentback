// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {QueueDescriptor, TopicDescriptor} from './descriptors.js';
import type {
  EnqueueOptions,
  JobContext,
  JobInfo,
  JobRef,
  MsgMeta,
  PublishOptions,
  QueueStats,
  Subscription,
  SubscribeOptions,
  WorkerOptions,
} from './types.js';

/** Durable job/worker port (hot-path audience). */
export interface JobQueue {
  enqueue<T>(
    q: QueueDescriptor<T>,
    data: T,
    opts?: EnqueueOptions,
  ): Promise<JobRef>;
  process<T>(
    q: QueueDescriptor<T>,
    handler: (job: JobContext<T>) => Promise<void>,
    opts?: WorkerOptions,
  ): Subscription;
  get<T>(q: QueueDescriptor<T>, id: string): Promise<JobInfo<T> | undefined>;
  cancel(q: QueueDescriptor<unknown>, id: string): Promise<boolean>;
}

/** Pub/sub fan-out port (implicit ack-on-resolve, at-least-once per group). */
export interface EventBus {
  publish<E>(
    t: TopicDescriptor<E>,
    event: E,
    opts?: PublishOptions,
  ): Promise<void>;
  subscribe<E>(
    t: TopicDescriptor<E>,
    group: string,
    handler: (event: E, msg: MsgMeta) => Promise<void>,
    opts?: SubscribeOptions,
  ): Subscription;
}

/** Operational/maintenance surface (tooling audience; inject optional). */
export interface QueueAdmin {
  stats(q: QueueDescriptor<unknown>): Promise<QueueStats>;
  drain(q: QueueDescriptor<unknown>): Promise<void>;
  pause(q: QueueDescriptor<unknown>): Promise<void>;
  resume(q: QueueDescriptor<unknown>): Promise<void>;
  discardStalled(
    q: QueueDescriptor<unknown>,
    olderThanSecs: number,
    opts?: {dryRun?: boolean},
  ): Promise<number>;
}

/** Cron/scheduling helper over JobQueue (not a backend port). */
export interface Scheduler {
  schedule<T>(
    q: QueueDescriptor<T>,
    data: T,
    when: {cron?: string; everyMs?: number; key: string},
  ): Promise<JobRef>;
  unschedule(q: QueueDescriptor<unknown>, key: string): Promise<boolean>;
}
