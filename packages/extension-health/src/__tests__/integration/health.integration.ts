// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {RestApplication} from '@agentback/rest';
import {
  HEALTH_CHECK_TAG,
  installHealth,
  registerHealthCheck,
} from '../../index.js';

async function bootApp(opts: {checks?: Array<[string, unknown]>} = {}) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  for (const [key, check] of opts.checks ?? []) {
    app.bind(key).to(check).tag(HEALTH_CHECK_TAG);
  }
  await installHealth(app);
  await app.start();
  const server = await app.restServer;
  return {app, client: supertest(server.url)};
}

describe('extension-health', () => {
  let teardown: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (teardown) await teardown();
    teardown = undefined;
  });

  it('/health returns UP with no checks registered', async () => {
    const {app, client} = await bootApp();
    teardown = () => app.stop();
    const r = await client.get('/health').expect(200);
    expect(r.body).toEqual({status: 'UP', checks: []});
  });

  it('/ready returns READY with no checks registered', async () => {
    const {app, client} = await bootApp();
    teardown = () => app.stop();
    const r = await client.get('/ready').expect(200);
    expect(r.body.status).toBe('READY');
  });

  it('passing readiness check → /ready returns 200 with check result', async () => {
    const {app, client} = await bootApp({
      checks: [
        [
          'health.checks.db',
          {
            name: 'database',
            type: 'readiness',
            async check() {},
          },
        ],
      ],
    });
    teardown = () => app.stop();
    const r = await client.get('/ready').expect(200);
    expect(r.body.status).toBe('READY');
    expect(r.body.checks).toHaveLength(1);
    expect(r.body.checks[0]).toMatchObject({name: 'database', ok: true});
  });

  it('failing readiness check → /ready returns 503', async () => {
    const {app, client} = await bootApp({
      checks: [
        [
          'health.checks.db',
          {
            name: 'database',
            type: 'readiness',
            async check() {
              throw new Error('connection refused');
            },
          },
        ],
      ],
    });
    teardown = () => app.stop();
    const r = await client.get('/ready').expect(503);
    expect(r.body.status).toBe('NOT_READY');
    expect(r.body.checks[0]).toMatchObject({
      name: 'database',
      ok: false,
      error: 'connection refused',
    });
  });

  it('readiness check returning {ok:false} marks failure', async () => {
    const {app, client} = await bootApp({
      checks: [
        [
          'health.checks.x',
          {
            name: 'x',
            async check() {
              return {ok: false, info: 'degraded'};
            },
          },
        ],
      ],
    });
    teardown = () => app.stop();
    const r = await client.get('/ready').expect(503);
    expect(r.body.checks[0]).toMatchObject({
      name: 'x',
      ok: false,
      info: 'degraded',
    });
  });

  it('readiness checks do NOT affect /health (liveness only)', async () => {
    const {app, client} = await bootApp({
      checks: [
        [
          'health.checks.db',
          {
            name: 'database',
            type: 'readiness',
            async check() {
              throw new Error('down');
            },
          },
        ],
      ],
    });
    teardown = () => app.stop();
    await client.get('/health').expect(200);
    await client.get('/ready').expect(503);
  });

  it('check timeout failure surfaces as ok:false', async () => {
    const {app, client} = await bootApp({
      checks: [
        [
          'health.checks.slow',
          {
            name: 'slow',
            type: 'readiness',
            timeoutMs: 20,
            async check() {
              await new Promise(r => setTimeout(r, 200));
            },
          },
        ],
      ],
    });
    teardown = () => app.stop();
    const r = await client.get('/ready').expect(503);
    expect(r.body.checks[0]).toMatchObject({name: 'slow', ok: false});
    expect(String(r.body.checks[0].error)).toMatch(/timed out/);
  });

  it('registerHealthCheck convenience binds with the right tag', async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    registerHealthCheck(app, 'health.checks.alpha', {
      name: 'alpha',
      async check() {},
    });
    await installHealth(app);
    await app.start();
    const server = await app.restServer;
    const client = supertest(server.url);
    const r = await client.get('/ready').expect(200);
    expect(r.body.checks[0].name).toBe('alpha');
    await app.stop();
  });
});
