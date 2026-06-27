// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  context as otelContext,
  propagation,
  ROOT_CONTEXT,
  trace,
  type Context as OtelContext,
  type ContextManager,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {W3CTraceContextPropagator} from '@opentelemetry/core';

/**
 * Minimal context manager for tests: tracks the active context across
 * sequential sync and async `with` calls (restores on settle). Not safe for
 * concurrent flows — fine for vitest's sequential test bodies, and avoids a
 * devDep on `@opentelemetry/context-async-hooks`.
 */
class TestContextManager implements ContextManager {
  private current: OtelContext = ROOT_CONTEXT;

  active(): OtelContext {
    return this.current;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: OtelContext,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const prev = this.current;
    this.current = context;
    try {
      const result = fn.call(thisArg, ...args);
      if (result instanceof Promise) {
        return result.finally(() => {
          this.current = prev;
        }) as ReturnType<F>;
      }
      this.current = prev;
      return result;
    } catch (err) {
      this.current = prev;
      throw err;
    }
  }

  bind<T>(_context: OtelContext, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.current = ROOT_CONTEXT;
    return this;
  }
}

export interface TestTracing {
  exporter: InMemorySpanExporter;
  spans(): ReadableSpan[];
  reset(): void;
}

/**
 * Register a BasicTracerProvider + InMemorySpanExporter as the global OTel
 * SDK (with W3C tracecontext propagation and the sequential test context
 * manager). Call `reset()` after the suite to restore the no-op globals.
 *
 * SDK 2.x removed `BasicTracerProvider.register()` (it lives only on the
 * node/web providers now), so we wire the three globals by hand via the
 * `@opentelemetry/api` setters — including the W3C propagator that
 * `register()` used to install by default (the trace-join tests need it).
 */
export function setupTestTracing(): TestTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  otelContext.setGlobalContextManager(new TestContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  return {
    exporter,
    spans: () => exporter.getFinishedSpans(),
    reset: () => {
      trace.disable();
      otelContext.disable();
      propagation.disable();
    },
  };
}

/** Poll until `cond` is true (spans are exported asynchronously to the test). */
export async function waitFor(
  cond: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
