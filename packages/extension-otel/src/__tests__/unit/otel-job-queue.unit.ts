// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {defineQueue, InMemoryJobQueue} from '@agentback/messaging';
import {OtelJobQueue} from '../../index.js';
import {setupTestTracing, waitFor} from '../support/test-tracing.js';

const tracing = setupTestTracing();

const Emails = defineQueue('emails', z.object({to: z.string()}));

describe('OtelJobQueue', () => {
  beforeEach(() => {
    tracing.exporter.reset();
  });

  afterAll(() => {
    tracing.reset();
  });

  it('opens a PRODUCER span per enqueue with destination + message id', async () => {
    const queue = new OtelJobQueue(new InMemoryJobQueue());
    const ref = await queue.enqueue(Emails, {to: 'a@b.c'});
    const span = tracing.spans().find(s => s.name === 'emails send')!;
    expect(span).toBeDefined();
    expect(span.kind).toBe(SpanKind.PRODUCER);
    expect(span.attributes['messaging.destination.name']).toBe('emails');
    expect(span.attributes['messaging.operation.type']).toBe('send');
    expect(span.attributes['messaging.message.id']).toBe(ref.id);
  });

  it('wraps the handler in a CONSUMER span on process', async () => {
    const queue = new OtelJobQueue(new InMemoryJobQueue());
    const ref = await queue.enqueue(Emails, {to: 'a@b.c'});
    const sub = queue.process(Emails, async () => {});
    try {
      await waitFor(() =>
        tracing.spans().some(s => s.name === 'emails process'),
      );
    } finally {
      await sub.close();
    }
    const span = tracing.spans().find(s => s.name === 'emails process')!;
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.attributes['messaging.destination.name']).toBe('emails');
    expect(span.attributes['messaging.operation.type']).toBe('process');
    expect(span.attributes['messaging.message.id']).toBe(ref.id);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('links producer and consumer spans into one trace via job meta', async () => {
    const queue = new OtelJobQueue(new InMemoryJobQueue());
    await queue.enqueue(Emails, {to: 'a@b.c'});
    const sub = queue.process(Emails, async () => {});
    try {
      await waitFor(() =>
        tracing.spans().some(s => s.name === 'emails process'),
      );
    } finally {
      await sub.close();
    }
    const producer = tracing.spans().find(s => s.name === 'emails send')!;
    const consumer = tracing.spans().find(s => s.name === 'emails process')!;
    expect(consumer.spanContext().traceId).toBe(producer.spanContext().traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(
      producer.spanContext().spanId,
    );
  });

  it('preserves caller-supplied meta while injecting trace context', async () => {
    const queue = new OtelJobQueue(new InMemoryJobQueue());
    const seen: Array<Record<string, string>> = [];
    const sub = queue.process(Emails, async job => {
      seen.push(job.meta);
    });
    await queue.enqueue(Emails, {to: 'a@b.c'}, {meta: {tenant: 't1'}});
    try {
      await waitFor(() => seen.length === 1);
    } finally {
      await sub.close();
    }
    expect(seen[0].tenant).toBe('t1');
    expect(seen[0].traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-/);
  });

  it('records handler failures on the CONSUMER span and lets retries proceed', async () => {
    const queue = new OtelJobQueue(new InMemoryJobQueue());
    await queue.enqueue(Emails, {to: 'a@b.c'});
    const sub = queue.process(Emails, async () => {
      throw new Error('smtp down');
    });
    try {
      await waitFor(() =>
        tracing.spans().some(s => s.name === 'emails process'),
      );
    } finally {
      await sub.close();
    }
    const span = tracing.spans().find(s => s.name === 'emails process')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    const exception = span.events.find(e => e.name === 'exception');
    expect(exception?.attributes?.['exception.message']).toBe('smtp down');
  });

  it('delegates get/cancel to the inner queue untouched', async () => {
    const queue = new OtelJobQueue(new InMemoryJobQueue());
    const ref = await queue.enqueue(Emails, {to: 'a@b.c'}, {delayMs: 60_000});
    const info = await queue.get(Emails, ref.id);
    expect(info?.state).toBe('delayed');
    expect(await queue.cancel(Emails, ref.id)).toBe(true);
    expect(await queue.get(Emails, ref.id)).toBeUndefined();
  });
});
