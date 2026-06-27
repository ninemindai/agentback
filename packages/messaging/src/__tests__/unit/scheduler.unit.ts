// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {defineQueue} from '../../descriptors.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';
import {DefaultScheduler} from '../../scheduler.js';
import type {EnqueueOptions} from '../../types.js';
import type {QueueDescriptor} from '../../descriptors.js';

describe('DefaultScheduler', () => {
  const Q = defineQueue('sched.jobs', z.object({n: z.number()}));

  it('schedule() enqueues with a repeat option carrying the key', async () => {
    const calls: EnqueueOptions[] = [];
    const queue = new InMemoryJobQueue();
    const spy = {
      ...queue,
      enqueue: async (
        q: QueueDescriptor<unknown>,
        data: unknown,
        opts?: EnqueueOptions,
      ) => {
        if (opts) calls.push(opts);
        return {id: 'x', queue: q.name};
      },
    };
    const scheduler = new DefaultScheduler(spy as unknown as InMemoryJobQueue);
    await scheduler.schedule(Q, {n: 1}, {cron: '*/5 * * * *', key: 'k1'});
    expect(calls[0].repeat).toEqual({cron: '*/5 * * * *', key: 'k1'});
  });
});
