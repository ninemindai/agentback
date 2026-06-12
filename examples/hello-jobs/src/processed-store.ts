// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import {z} from 'zod';
import {EmailJob} from './jobs.js';

/** A record of a job the worker finished, so tests can observe completion. */
export interface ProcessedJob {
  jobId: string;
  payload: z.infer<typeof EmailJob>;
}

/**
 * Tiny in-memory sink the worker writes to on completion. Bound as a singleton
 * so the controller, the worker, and the test all share the same instance.
 */
export class ProcessedJobs {
  readonly all: ProcessedJob[] = [];
  record(job: ProcessedJob): void {
    this.all.push(job);
  }
}

export const PROCESSED_JOBS = BindingKey.create<ProcessedJobs>(
  'stores.ProcessedJobs',
);
