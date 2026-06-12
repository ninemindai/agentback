// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {
  InMemoryMessagingComponent,
  MESSAGING_PROCESSOR_TAG,
} from '@agentback/messaging';
import {EmailController} from './controllers/email.controller.js';
import {EmailWorker} from './email.worker.js';
import {ProcessedJobs, PROCESSED_JOBS} from './processed-store.js';

/**
 * hello-jobs application: an HTTP endpoint and a background worker that share
 * one Zod schema (`EmailJob`) for the request body and the job payload.
 *
 * `InMemoryMessagingComponent` binds the four messaging ports plus the
 * `MessagingBootstrapper`, which at `start()` discovers every binding tagged
 * `MESSAGING_PROCESSOR_TAG` and wires its `@jobProcessor` methods to the
 * queue. The README shows swapping in BullMQMessagingComponent for durable,
 * Redis-backed processing — the controller and worker don't change.
 */
export class HelloJobsApplication extends RestApplication {
  constructor() {
    super();

    // Binds JobQueue / EventBus / QueueAdmin / Scheduler + the bootstrapper.
    this.component(InMemoryMessagingComponent);

    // Shared completion sink (singleton so controller, worker, and tests agree).
    this.bind(PROCESSED_JOBS)
      .toClass(ProcessedJobs)
      .inScope(BindingScope.SINGLETON);

    this.restController(EmailController);

    // Tag the worker so the bootstrapper discovers and wires its @jobProcessor.
    this.bind('workers.EmailWorker')
      .toClass(EmailWorker)
      .tag(MESSAGING_PROCESSOR_TAG);
  }
}
