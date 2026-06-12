// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeEach} from 'vitest';
import {z} from 'zod';
import {Context} from '@agentback/core';
import {defineQueue} from '../../descriptors.js';
import {jobProcessor} from '../../decorators.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';
import {InMemoryEventBus} from '../../in-memory/in-memory-event-bus.js';
import {MessagingBootstrapper} from '../../bootstrapper.js';
import {EVENT_BUS, JOB_QUEUE, MESSAGING_PROCESSOR_TAG} from '../../keys.js';

const Q = defineQueue('boot.jobs', z.object({n: z.number()}));
const tick = (ms = 30) => new Promise<void>(r => setTimeout(r, ms));

describe('MessagingBootstrapper', () => {
  let ctx: Context;
  let queue: InMemoryJobQueue;

  beforeEach(() => {
    ctx = new Context('test');
    queue = new InMemoryJobQueue();
    ctx.bind(JOB_QUEUE).to(queue);
    ctx.bind(EVENT_BUS).to(new InMemoryEventBus());
  });

  it('wires a @jobProcessor method to the queue at start()', async () => {
    const seen: number[] = [];
    class Worker {
      @jobProcessor(Q)
      async run(job: {data: {n: number}}) {
        seen.push(job.data.n);
      }
    }
    ctx.bind('workers.Worker').toClass(Worker).tag(MESSAGING_PROCESSOR_TAG);

    const boot = new MessagingBootstrapper(ctx, queue, ctx.getSync(EVENT_BUS));
    await boot.start();
    await queue.enqueue(Q, {n: 42});
    await tick();
    expect(seen).toEqual([42]);
    await boot.stop();
  });

  it('stop() closes subscriptions so jobs stop being processed', async () => {
    const seen: number[] = [];
    class Worker {
      @jobProcessor(Q)
      async run(job: {data: {n: number}}) {
        seen.push(job.data.n);
      }
    }
    ctx.bind('workers.Worker').toClass(Worker).tag(MESSAGING_PROCESSOR_TAG);
    const boot = new MessagingBootstrapper(ctx, queue, ctx.getSync(EVENT_BUS));
    await boot.start();
    await boot.stop();
    await queue.enqueue(Q, {n: 1});
    await tick();
    expect(seen).toEqual([]);
  });
});
