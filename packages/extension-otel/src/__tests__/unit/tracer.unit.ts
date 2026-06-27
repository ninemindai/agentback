// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, describe, expect, it} from 'vitest';
import {trace} from '@opentelemetry/api';
import {getActiveTraceId, TRACER_NAME} from '../../index.js';
import {setupTestTracing} from '../support/test-tracing.js';

const tracing = setupTestTracing();

describe('getActiveTraceId', () => {
  afterAll(() => {
    tracing.reset();
  });

  it('returns the active span trace id inside a span scope', () => {
    const tracer = trace.getTracer(TRACER_NAME);
    let inside: string | undefined;
    let expected: string | undefined;
    tracer.startActiveSpan('probe', span => {
      expected = span.spanContext().traceId;
      inside = getActiveTraceId();
      span.end();
    });
    expect(inside).toBeDefined();
    expect(inside).toBe(expected);
  });

  it('returns undefined when no span is active', () => {
    expect(getActiveTraceId()).toBeUndefined();
  });
});
