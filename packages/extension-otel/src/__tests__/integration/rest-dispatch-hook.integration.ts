// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {
  InMemoryUsageSink,
  Meter,
  MeteringComponent,
  MeteringBindings,
} from '@agentback/metering';
import {installOtel} from '../../index.js';
import {setupTestTracing, waitFor} from '../support/test-tracing.js';

const tracing = setupTestTracing();

const Ok = z.object({ok: z.boolean()});

class WidgetController {
  @get('/ok', {response: Ok})
  async ok(): Promise<z.infer<typeof Ok>> {
    return {ok: true};
  }

  @get('/fail')
  async fail(): Promise<never> {
    throw Object.assign(new Error('service melted'), {statusCode: 503});
  }
}

describe('REST dispatch hook (integration)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(() => {
    tracing.exporter.reset();
  });

  afterEach(async () => {
    await app.stop();
  });

  async function startApp(opts: {metered?: boolean} = {}) {
    app = new RestApplication({});
    if (opts.metered) app.component(MeteringComponent);
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(WidgetController);
    await installOtel(app);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  }

  it('wraps dispatch in an INTERNAL span named rest.dispatch <Controller.method>', async () => {
    await startApp();
    await client.get('/ok').expect(200);
    await waitFor(() =>
      tracing.spans().some(s => s.name === 'rest.dispatch WidgetController.ok'),
    );
    const span = tracing
      .spans()
      .find(s => s.name === 'rest.dispatch WidgetController.ok')!;
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.attributes['code.namespace']).toBe('WidgetController');
    expect(span.attributes['code.function']).toBe('ok');
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('records exceptions and sets ERROR status when the handler throws', async () => {
    await startApp();
    await client.get('/fail').expect(503);
    await waitFor(() =>
      tracing
        .spans()
        .some(s => s.name === 'rest.dispatch WidgetController.fail'),
    );
    const span = tracing
      .spans()
      .find(s => s.name === 'rest.dispatch WidgetController.fail')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('service melted');
    const exception = span.events.find(e => e.name === 'exception');
    expect(exception).toBeDefined();
    expect(exception!.attributes?.['exception.message']).toBe('service melted');
  });

  it('composes with the metering hooks: one request produces a span AND a usage event', async () => {
    // Two cross-cutting concerns as sibling dispatch hooks — the
    // composition the subclass-only design could not express. Both
    // observability signals fire for one request.
    await startApp({metered: true});
    const sink = new InMemoryUsageSink();
    app.bind(MeteringBindings.METER.key).to(new Meter(sink));
    const r = await client.get('/ok').expect(200);
    expect(r.body).toEqual({ok: true});
    await waitFor(() =>
      tracing.spans().some(s => s.name === 'rest.dispatch WidgetController.ok'),
    );
    await waitFor(() => sink.all().length === 1);
    const [event] = sink.all();
    expect(event.surface).toBe('rest');
    expect(event.operation).toBe('WidgetController.ok');
    expect(event.status).toBe('ok');
  });
});
