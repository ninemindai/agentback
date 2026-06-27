// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Proves the shared schema end-to-end: POST /emails validates the body with
// EmailJob and enqueues it; the worker (same EmailJob schema on consume)
// processes it and records completion; GET /emails/{id} reports the state.

import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {HelloJobsApplication} from '../application.js';
import {PROCESSED_JOBS, type ProcessedJobs} from '../processed-store.js';

describe('hello-jobs', () => {
  it('enqueues from POST /emails and the worker processes it', async () => {
    await using t = await createTestApp(HelloJobsApplication);
    const processed = t.app.getSync<ProcessedJobs>(PROCESSED_JOBS.key);

    const payload = {to: 'ada@example.com', subject: 'Welcome'};
    const res = await t.http.post('/emails').send(payload).expect(202);
    const jobId: string = res.body.jobId;
    expect(jobId).toBeTruthy();

    // Wait for the in-memory worker to settle.
    await expect
      .poll(() => processed.all.length, {timeout: 5000})
      .toBeGreaterThan(0);

    expect(processed.all).toHaveLength(1);
    expect(processed.all[0]).toMatchObject({jobId, payload});

    // The status route reflects the completed job.
    const status = await t.http.get(`/emails/${jobId}`).expect(200);
    expect(status.body).toMatchObject({jobId, state: 'completed'});
  });

  it('rejects an invalid body with 422', async () => {
    await using t = await createTestApp(HelloJobsApplication);
    // `to` is not an email → EmailJob validation fails before enqueue.
    await t.http
      .post('/emails')
      .send({to: 'not-an-email', subject: 'x'})
      .expect(422);
  });
});
