// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {Registry} from 'prom-client';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {installMetrics} from '../../index.js';

@api({basePath: '/p'})
class PingController {
  @get('/ping', {response: z.object({pong: z.boolean()})})
  ping() {
    return {pong: true};
  }
}

describe('extension-metrics', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;
  let registry: Registry;

  beforeEach(async () => {
    // Use a per-test isolated registry so metrics don't leak across tests.
    registry = new Registry();
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(PingController);
    await installMetrics(app, {registry});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterEach(async () => app.stop());

  it('exposes /metrics with Prometheus content-type', async () => {
    const r = await client.get('/metrics').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.text).toMatch(/^# HELP/m);
  });

  it('includes Node.js process metrics by default', async () => {
    const r = await client.get('/metrics').expect(200);
    expect(r.text).toMatch(/process_cpu_user_seconds_total/);
    expect(r.text).toMatch(/process_resident_memory_bytes/);
  });

  it('records http_request_duration_seconds with method/route/status labels', async () => {
    await client.get('/p/ping').expect(200);
    const r = await client.get('/metrics').expect(200);
    expect(r.text).toMatch(
      /http_request_duration_seconds_count\{method="GET",route="\/p\/ping",status_code="200"\} \d+/,
    );
  });

  it('captures error status codes too', async () => {
    await client.get('/does-not-exist').expect(404);
    const r = await client.get('/metrics').expect(200);
    expect(r.text).toMatch(/status_code="404"/);
  });
});
