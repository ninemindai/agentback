// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Binding,
  createBindingFromClass,
  type Component,
} from '@agentback/core';
import {MessagingBootstrapper} from './bootstrapper.js';
import {InMemoryEventBus} from './in-memory/in-memory-event-bus.js';
import {InMemoryJobQueue} from './in-memory/in-memory-job-queue.js';
import {InMemoryQueueAdmin} from './in-memory/in-memory-queue-admin.js';
import {EVENT_BUS, JOB_QUEUE, QUEUE_ADMIN, SCHEDULER} from './keys.js';
import {DefaultScheduler} from './scheduler.js';

/**
 * Wires the in-memory messaging adapter to all four ports plus the
 * bootstrapper. Layer 2 ships a parallel RedisMessagingComponent binding the
 * BullMQ/Streams adapter to the same keys.
 */
export class InMemoryMessagingComponent implements Component {
  bindings: Binding[];

  constructor() {
    const queue = new InMemoryJobQueue();
    const eventBus = new InMemoryEventBus();
    const admin = new InMemoryQueueAdmin(queue.backingStore);
    const scheduler = new DefaultScheduler(queue);

    this.bindings = [
      Binding.bind(JOB_QUEUE).to(queue),
      Binding.bind(EVENT_BUS).to(eventBus),
      Binding.bind(QUEUE_ADMIN).to(admin),
      Binding.bind(SCHEDULER).to(scheduler),
      createBindingFromClass(MessagingBootstrapper),
    ];
  }
}
