// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The worker side of the shared schema. `@jobProcessor(SendEmail)` registers
// this method as the processor for the `send-email` queue; the bootstrapper
// (wired by InMemoryMessagingComponent) discovers it at app.start() via the
// MESSAGING_PROCESSOR_TAG on its binding. `job.data` is already Zod-decoded
// from the SAME `EmailJob` schema the HTTP body was validated against.

import {inject} from '@agentback/core';
import {jobProcessor, type JobContext} from '@agentback/messaging';
import {z} from 'zod';
import {EmailJob, SendEmail} from './jobs.js';
import {PROCESSED_JOBS, type ProcessedJobs} from './processed-store.js';

export class EmailWorker {
  constructor(@inject(PROCESSED_JOBS) private processed: ProcessedJobs) {}

  @jobProcessor(SendEmail)
  async send(job: JobContext<z.infer<typeof EmailJob>>): Promise<void> {
    // A real worker would hand off to an email provider here. We record the
    // completed job so the controller's status route and the test can observe
    // that processing finished.
    this.processed.record({jobId: job.id, payload: job.data});
  }
}
