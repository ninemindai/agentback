// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  isSpanContextValid,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

/** The instrumentation-scope name every span in this package is created under. */
export const TRACER_NAME = '@agentback/extension-otel';

/** The package-scoped tracer. No-ops when no OTel SDK is registered. */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * The trace id of the currently-active span, or `undefined` when no span is
 * active (or no SDK is registered, in which case span contexts are invalid).
 *
 * Intended as the correlation hook for other subsystems — e.g. a `Meter`
 * implementation can stamp it onto `UsageEvent.traceId` so billing records
 * and traces share one join key.
 */
export function getActiveTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const spanContext = span.spanContext();
  return isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

/** Record an exception on the span and mark it errored. */
export function recordError(span: Span, err: unknown): void {
  const e = err instanceof Error ? err : new Error(String(err));
  span.recordException(e);
  span.setStatus({code: SpanStatusCode.ERROR, message: e.message});
}
