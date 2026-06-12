// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MethodDecoratorFactory} from '@agentback/metadata';
import type {QueueDescriptor, TopicDescriptor} from './descriptors.js';
import {JOB_PROCESSOR_METADATA_KEY, SUBSCRIBER_METADATA_KEY} from './keys.js';
import type {SubscribeOptions, WorkerOptions} from './types.js';

/** Metadata stored by @jobProcessor (descriptor kept for schema decoding). */
export interface JobProcessorMetadata {
  queueName: string;
  descriptor: QueueDescriptor<unknown>;
  options?: WorkerOptions;
  methodName: string;
}

/** Metadata stored by @subscriber. */
export interface SubscriberMetadata {
  topicName: string;
  descriptor: TopicDescriptor<unknown>;
  group: string;
  options?: SubscribeOptions;
  methodName: string;
}

/** Register a method as a JobQueue processor for `q`. */
export function jobProcessor<T>(
  q: QueueDescriptor<T>,
  options?: WorkerOptions,
): MethodDecorator {
  return function (target, methodName, descriptor) {
    const meta: JobProcessorMetadata = {
      queueName: q.name,
      descriptor: q as QueueDescriptor<unknown>,
      options,
      methodName: methodName as string,
    };
    MethodDecoratorFactory.createDecorator<JobProcessorMetadata>(
      JOB_PROCESSOR_METADATA_KEY,
      meta,
      {decoratorName: '@jobProcessor'},
    )(target, methodName, descriptor);
  };
}

/** Register a method as an EventBus subscriber on `t` for `group`. */
export function subscriber<E>(
  t: TopicDescriptor<E>,
  group: string,
  options?: SubscribeOptions,
): MethodDecorator {
  return function (target, methodName, descriptor) {
    const meta: SubscriberMetadata = {
      topicName: t.name,
      descriptor: t as TopicDescriptor<unknown>,
      group,
      options,
      methodName: methodName as string,
    };
    MethodDecoratorFactory.createDecorator<SubscriberMetadata>(
      SUBSCRIBER_METADATA_KEY,
      meta,
      {decoratorName: '@subscriber'},
    )(target, methodName, descriptor);
  };
}
