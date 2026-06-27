// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import type {EventBus, JobQueue, QueueAdmin, Scheduler} from './ports.js';

export const JOB_QUEUE = BindingKey.create<JobQueue>('messaging.JobQueue');
export const EVENT_BUS = BindingKey.create<EventBus>('messaging.EventBus');
export const QUEUE_ADMIN = BindingKey.create<QueueAdmin>(
  'messaging.QueueAdmin',
);
export const SCHEDULER = BindingKey.create<Scheduler>('messaging.Scheduler');

/** Tag marking a binding that has @jobProcessor methods. */
export const MESSAGING_PROCESSOR_TAG = 'messaging:processor';
/** Tag marking a binding that has @subscriber methods. */
export const MESSAGING_SUBSCRIBER_TAG = 'messaging:subscriber';

/** Metadata key for @jobProcessor method metadata. */
export const JOB_PROCESSOR_METADATA_KEY = 'messaging:jobProcessor';
/** Metadata key for @subscriber method metadata. */
export const SUBSCRIBER_METADATA_KEY = 'messaging:subscriber';
