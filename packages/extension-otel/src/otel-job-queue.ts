// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  context as otelContext,
  propagation,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import type {
  EnqueueOptions,
  JobContext,
  JobInfo,
  JobQueue,
  JobRef,
  QueueDescriptor,
  Subscription,
  WorkerOptions,
} from '@agentback/messaging';
import {getTracer, recordError} from './tracer.js';

/**
 * Tracing decorator over any {@link JobQueue} port implementation (in-memory,
 * BullMQ, …) — composes at the port, not via subclassing, so it works over
 * every adapter:
 *
 * ```ts
 * const queue = new OtelJobQueue(new InMemoryJobQueue());
 * ```
 *
 * - `enqueue` runs inside a `PRODUCER` span `<queue> send` (attributes:
 *   `messaging.destination.name`, `messaging.operation.type`, and
 *   `messaging.message.id` once the job ref is known). The span parents
 *   under the caller's active span, so "request → enqueue" is one trace.
 * - `process` wraps the handler in a `CONSUMER` span `<queue> process`
 *   (same destination attributes plus the job id); handler throws are
 *   recorded with an `ERROR` status before the queue's retry semantics run.
 *
 * Cross-process trace linking: `enqueue` injects the active W3C trace
 * context (`traceparent`/`tracestate`) into the job's transport metadata
 * envelope (`EnqueueOptions.meta`) via `propagation.inject`; `process`
 * extracts it from `job.meta` and parents the `CONSUMER` span under it, so
 * producer and consumer share one trace even across processes. The
 * validated payload is untouched — meta travels beside it.
 */
export class OtelJobQueue implements JobQueue {
  constructor(private readonly inner: JobQueue) {}

  async enqueue<T>(
    q: QueueDescriptor<T>,
    data: T,
    opts?: EnqueueOptions,
  ): Promise<JobRef> {
    const span = getTracer().startSpan(`${q.name} send`, {
      kind: SpanKind.PRODUCER,
      attributes: {
        'messaging.destination.name': q.name,
        'messaging.operation.type': 'send',
      },
    });
    return otelContext.with(
      trace.setSpan(otelContext.active(), span),
      async () => {
        try {
          // Inject W3C trace context (traceparent/tracestate) into the
          // transport metadata envelope so the consumer span can link up.
          const meta: Record<string, string> = {...opts?.meta};
          propagation.inject(otelContext.active(), meta);
          const ref = await this.inner.enqueue(q, data, {...opts, meta});
          span.setAttribute('messaging.message.id', ref.id);
          return ref;
        } catch (err) {
          recordError(span, err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }

  process<T>(
    q: QueueDescriptor<T>,
    handler: (job: JobContext<T>) => Promise<void>,
    opts?: WorkerOptions,
  ): Subscription {
    return this.inner.process(
      q,
      async job => {
        // Extract the producer's W3C trace context from the job's transport
        // metadata; the CONSUMER span then shares the producer's trace.
        const extracted = propagation.extract(otelContext.active(), job.meta);
        const span = getTracer().startSpan(
          `${q.name} process`,
          {
            kind: SpanKind.CONSUMER,
            attributes: {
              'messaging.destination.name': q.name,
              'messaging.operation.type': 'process',
              'messaging.message.id': job.id,
              'messaging.message.delivery_attempt': job.attempt,
            },
          },
          extracted,
        );
        return otelContext.with(trace.setSpan(extracted, span), async () => {
          try {
            await handler(job);
          } catch (err) {
            recordError(span, err);
            throw err;
          } finally {
            span.end();
          }
        });
      },
      opts,
    );
  }

  get<T>(q: QueueDescriptor<T>, id: string): Promise<JobInfo<T> | undefined> {
    return this.inner.get(q, id);
  }

  cancel(q: QueueDescriptor<unknown>, id: string): Promise<boolean> {
    return this.inner.cancel(q, id);
  }
}
