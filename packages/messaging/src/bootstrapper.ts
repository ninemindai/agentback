// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {
  BindingScope,
  ContextTags,
  inject,
  lifeCycleObserver,
  type Context,
  type LifeCycleObserver,
} from '@agentback/core';
import {MetadataInspector} from '@agentback/metadata';
import type {JobProcessorMetadata, SubscriberMetadata} from './decorators.js';
import type {EventBus, JobQueue} from './ports.js';
import type {Subscription} from './types.js';
import {
  EVENT_BUS,
  JOB_PROCESSOR_METADATA_KEY,
  JOB_QUEUE,
  MESSAGING_PROCESSOR_TAG,
  MESSAGING_SUBSCRIBER_TAG,
  SUBSCRIBER_METADATA_KEY,
} from './keys.js';

const {info, debug} = loggers('messaging:bootstrapper');

export const MESSAGING_BOOTSTRAPPER_KEY = 'observers.MessagingBootstrapper';

/**
 * Discovers @jobProcessor/@subscriber-tagged bindings at start() and wires
 * each decorated method to the JobQueue/EventBus. Holds the returned
 * Subscriptions and closes them on stop().
 */
@lifeCycleObserver('10-messaging-bootstrapper', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: MESSAGING_BOOTSTRAPPER_KEY},
})
export class MessagingBootstrapper implements LifeCycleObserver {
  private subscriptions: Subscription[] = [];

  constructor(
    @inject.context() private ctx: Context,
    @inject(JOB_QUEUE) private jobQueue: JobQueue,
    @inject(EVENT_BUS) private eventBus: EventBus,
  ) {}

  async start(): Promise<void> {
    await this.wireProcessors();
    await this.wireSubscribers();
    info(
      'MessagingBootstrapper wired %d subscriptions',
      this.subscriptions.length,
    );
  }

  private async wireProcessors(): Promise<void> {
    const bindings = this.ctx.findByTag(MESSAGING_PROCESSOR_TAG);
    for (const b of bindings) {
      const instance = (await this.ctx.get(b.key)) as object;
      const all = MetadataInspector.getAllMethodMetadata<JobProcessorMetadata>(
        JOB_PROCESSOR_METADATA_KEY,
        Object.getPrototypeOf(instance),
      );
      if (!all) continue;
      for (const methodName of Object.keys(all)) {
        const meta = all[methodName];
        const sub = this.jobQueue.process(
          meta.descriptor,
          async job => {
            await (
              instance as Record<string, (...a: unknown[]) => Promise<void>>
            )[methodName](job);
          },
          meta.options,
        );
        this.subscriptions.push(sub);
        debug(
          'wired @jobProcessor %s.%s -> %s',
          b.key,
          methodName,
          meta.queueName,
        );
      }
    }
  }

  private async wireSubscribers(): Promise<void> {
    const bindings = this.ctx.findByTag(MESSAGING_SUBSCRIBER_TAG);
    for (const b of bindings) {
      const instance = (await this.ctx.get(b.key)) as object;
      const all = MetadataInspector.getAllMethodMetadata<SubscriberMetadata>(
        SUBSCRIBER_METADATA_KEY,
        Object.getPrototypeOf(instance),
      );
      if (!all) continue;
      for (const methodName of Object.keys(all)) {
        const meta = all[methodName];
        const sub = this.eventBus.subscribe(
          meta.descriptor,
          meta.group,
          async (event, msg) => {
            await (
              instance as Record<string, (...a: unknown[]) => Promise<void>>
            )[methodName](event, msg);
          },
          meta.options,
        );
        this.subscriptions.push(sub);
        debug(
          'wired @subscriber %s.%s -> %s',
          b.key,
          methodName,
          meta.topicName,
        );
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.subscriptions.map(s => s.close()));
    this.subscriptions = [];
    debug('MessagingBootstrapper stopped');
  }
}
