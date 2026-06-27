// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The API side of the shared schema. `@post('/emails')` validates the body
// with the SAME `EmailJob` schema the queue uses, then enqueues it onto
// `SendEmail` — so the JobQueue never re-checks a different shape than the API
// accepted. `GET /emails/{id}` reports the job's state from the queue.

import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, get, post} from '@agentback/openapi';
import {JOB_QUEUE, type JobQueue} from '@agentback/messaging';
import {EmailJob, SendEmail} from '../jobs.js';

const EnqueueOut = z.object({jobId: z.string()});
const StatusOut = z.object({
  jobId: z.string(),
  state: z.string(),
});

@api({basePath: '/emails'})
export class EmailController {
  constructor(@inject(JOB_QUEUE) private jobs: JobQueue) {}

  @post('/', {body: EmailJob, response: EnqueueOut, status: 202})
  async enqueue(input: {
    body: z.infer<typeof EmailJob>;
  }): Promise<z.infer<typeof EnqueueOut>> {
    const ref = await this.jobs.enqueue(SendEmail, input.body);
    return {jobId: ref.id};
  }

  @get('/{id}', {path: z.object({id: z.string()}), response: StatusOut})
  async status(input: {
    path: {id: string};
  }): Promise<z.infer<typeof StatusOut>> {
    const info = await this.jobs.get(SendEmail, input.path.id);
    return {jobId: input.path.id, state: info?.state ?? 'unknown'};
  }
}
