// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {installOtel} from '../../index.js';
import {setupTestTracing, waitFor} from '../support/test-tracing.js';

// installOtel also binds the rest.dispatch hook, so each request produces a
// SERVER span (middleware) plus an INTERNAL dispatch span — filter to the
// middleware's spans here; the dispatch hook has its own suite.
const serverSpans = (t: ReturnType<typeof setupTestTracing>) =>
  t.spans().filter(s => s.kind === SpanKind.SERVER);

const tracing = setupTestTracing();

const Greeting = z.object({greeting: z.string()});
const HelloPath = z.object({name: z.string().min(1)});

class HelloController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @get('/boom')
  async boom(): Promise<never> {
    throw Object.assign(new Error('kaboom'), {statusCode: 500});
  }
}

describe('OTel REST middleware (integration)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(HelloController);
    await installOtel(app, {serverName: 'test-rest'});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => {
    await app.stop();
    tracing.reset();
  });

  beforeEach(() => {
    tracing.exporter.reset();
  });

  it('opens one SERVER span per request with method/path/status attrs', async () => {
    await client.get('/hello/world').expect(200);
    await waitFor(() => serverSpans(tracing).length === 1);
    const [span] = serverSpans(tracing);
    expect(span.name).toBe('GET /hello/world');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes['http.request.method']).toBe('GET');
    expect(span.attributes['url.path']).toBe('/hello/world');
    expect(span.attributes['http.response.status_code']).toBe(200);
    expect(span.attributes['loopback.server.name']).toBe('test-rest');
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('extracts an incoming W3C traceparent (distributed trace join)', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c';
    const parentSpanId = 'b7ad6b7169203331';
    await client
      .get('/hello/remote')
      .set('traceparent', `00-${traceId}-${parentSpanId}-01`)
      .expect(200);
    await waitFor(() => serverSpans(tracing).length === 1);
    const [span] = serverSpans(tracing);
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.parentSpanId).toBe(parentSpanId);
  });

  it('marks 5xx responses with an ERROR span status', async () => {
    await client.get('/boom').expect(500);
    await waitFor(() => serverSpans(tracing).length === 1);
    const [span] = serverSpans(tracing);
    expect(span.attributes['http.response.status_code']).toBe(500);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});
