// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {
  Binding,
  CoreTags,
  type Component,
  type LifeCycleObserver,
} from '@agentback/core';
import {
  EVENT_BUS,
  JOB_QUEUE,
  QUEUE_ADMIN,
  SCHEDULER,
} from '@agentback/messaging';
import {BullMQJobQueue} from './bullmq-job-queue.js';
import {BullMQQueueAdmin} from './bullmq-queue-admin.js';
import {BullMQScheduler} from './bullmq-scheduler.js';
import {
  RedisConnectionManager,
  type BullMQConnectionConfig,
} from './connection.js';
import {
  RedisStreamsEventBus,
  type RedisStreamsEventBusOptions,
} from './redis-streams-event-bus.js';

const {info} = loggers('messaging:bullmq:component');

export const BULLMQ_MESSAGING_OBSERVER_KEY =
  'observers.BullMQMessagingLifecycle';

export interface BullMQMessagingComponentOptions {
  /** Redis connection (url / ioredis options / existing client). */
  connection?: BullMQConnectionConfig;
  /** BullMQ key prefix for all queues. */
  prefix?: string;
  /** Redis Streams event-bus tuning. */
  eventBus?: RedisStreamsEventBusOptions;
}

/**
 * Closes the adapter in dependency order on application stop:
 * workers (graceful — waits for in-flight jobs) → queues → event-bus
 * subscribe loops → every Redis connection (duplicates, then base).
 *
 * Its group sorts before MessagingBootstrapper's
 * (`10-messaging-bootstrapper`), so on stop — which runs groups in reverse —
 * the bootstrapper closes its subscriptions first, then this observer tears
 * the transport down.
 */
export class BullMQMessagingLifecycleObserver implements LifeCycleObserver {
  constructor(
    private jobQueue: BullMQJobQueue,
    private eventBus: RedisStreamsEventBus,
    private connections: RedisConnectionManager,
  ) {}

  start(): void {
    // Connections and queues are created lazily; nothing to do.
  }

  async stop(): Promise<void> {
    await this.jobQueue.close();
    await this.eventBus.close();
    await this.connections.close();
    info('BullMQ messaging adapter stopped');
  }
}

/**
 * Rebinds the four messaging ports to the durable BullMQ/Redis adapter:
 *
 * ```ts
 * app.component(
 *   new BullMQMessagingComponent({connection: {url: process.env.REDIS_URL}}),
 * );
 * // JOB_QUEUE / EVENT_BUS / QUEUE_ADMIN / SCHEDULER now hit Redis;
 * // @jobProcessor / @subscriber classes need zero changes.
 * ```
 */
export class BullMQMessagingComponent implements Component {
  bindings: Binding[];

  readonly connections: RedisConnectionManager;
  readonly jobQueue: BullMQJobQueue;
  readonly eventBus: RedisStreamsEventBus;
  readonly queueAdmin: BullMQQueueAdmin;
  readonly scheduler: BullMQScheduler;

  constructor(options: BullMQMessagingComponentOptions = {}) {
    this.connections = new RedisConnectionManager(options.connection);
    this.jobQueue = new BullMQJobQueue(this.connections, {
      prefix: options.prefix,
    });
    this.eventBus = new RedisStreamsEventBus(
      this.connections,
      options.eventBus,
    );
    this.queueAdmin = new BullMQQueueAdmin(this.jobQueue);
    this.scheduler = new BullMQScheduler(this.jobQueue);
    const observer = new BullMQMessagingLifecycleObserver(
      this.jobQueue,
      this.eventBus,
      this.connections,
    );

    this.bindings = [
      Binding.bind(JOB_QUEUE).to(this.jobQueue),
      Binding.bind(EVENT_BUS).to(this.eventBus),
      Binding.bind(QUEUE_ADMIN).to(this.queueAdmin),
      Binding.bind(SCHEDULER).to(this.scheduler),
      Binding.bind(BULLMQ_MESSAGING_OBSERVER_KEY)
        .to(observer)
        .tag(CoreTags.LIFE_CYCLE_OBSERVER)
        .tag({[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: '00-messaging-bullmq'}),
    ];
  }
}
