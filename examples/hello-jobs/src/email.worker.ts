// Copyright NineMind, Inc. 2026. All Rights Reserved.
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

  // `timeoutMs` is the wall-clock backstop for one attempt: a run stalled
  // inside an attempt stops counting turns while it keeps billing, and only a
  // clock ends that. On elapse the attempt is abandoned (job.signal aborts,
  // the seat is freed) and NOT retried.
  @jobProcessor(SendEmail, {timeoutMs: 30_000})
  async send(job: JobContext<z.infer<typeof EmailJob>>): Promise<void> {
    // A real worker would hand off to an email provider here — passing
    // `job.signal` into that call is what makes the deadline actually stop
    // the work rather than merely stop waiting for it.
    this.processed.record({jobId: job.id, payload: job.data});
  }
}
