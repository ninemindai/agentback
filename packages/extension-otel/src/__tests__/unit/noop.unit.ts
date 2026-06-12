// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// IMPORTANT: this file intentionally registers NO tracer provider — it
// verifies the "no-op without an SDK" guarantee. Vitest isolates test files
// in their own workers, so the providers registered by sibling test files
// never leak in here.

import {afterAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {defineQueue, InMemoryJobQueue} from '@agentback/messaging';
import {getActiveTraceId, installOtel, OtelJobQueue} from '../../index.js';

const Ok = z.object({ok: z.boolean()});

class NoopController {
  @get('/ok', {response: Ok})
  async ok(): Promise<z.infer<typeof Ok>> {
    return {ok: true};
  }
}

describe('without a registered OTel SDK (no-op guarantee)', () => {
  let app: RestApplication | undefined;

  afterAll(async () => {
    if (app) await app.stop();
  });

  it('getActiveTraceId returns undefined', () => {
    expect(getActiveTraceId()).toBeUndefined();
  });

  it('middleware + dispatch hooks serve requests unchanged', async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(NoopController);
    await installOtel(app);
    await app.start();
    const server = await app.restServer;
    const r = await supertest(server.url).get('/ok').expect(200);
    expect(r.body).toEqual({ok: true});
  });

  it('OtelJobQueue enqueues and processes jobs unchanged', async () => {
    const Q = defineQueue('noop-q', z.object({n: z.number()}));
    const queue = new OtelJobQueue(new InMemoryJobQueue());
    const seen: number[] = [];
    const ref = await queue.enqueue(Q, {n: 7});
    expect(ref.queue).toBe('noop-q');
    const sub = queue.process(Q, async job => {
      seen.push(job.data.n);
    });
    try {
      const start = Date.now();
      while (seen.length === 0 && Date.now() - start < 2000) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally {
      await sub.close();
    }
    expect(seen).toEqual([7]);
  });
});
