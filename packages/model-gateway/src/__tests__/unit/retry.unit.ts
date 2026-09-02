// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {AbortReasons, abortError} from '@agentback/common';
import {CircuitOpenError} from '../../errors.js';
import {retryPolicy, isRetryable} from '../../retry.js';
import type {LanguageModelLike, ModelGenerateResult} from '../../types.js';

const MODEL = {modelId: 'test-model', provider: 'test'} as LanguageModelLike;

/** Drive a middleware's wrapGenerate against a scripted doGenerate. */
function drive(
  mw: ReturnType<typeof retryPolicy>,
  doGenerate: () => PromiseLike<ModelGenerateResult>,
  params: Record<string, unknown> = {},
) {
  return mw.wrapGenerate!({
    doGenerate,
    doStream: () => Promise.resolve({}),
    params,
    model: MODEL,
  });
}

const httpError = (statusCode: number, extra: object = {}) =>
  Object.assign(new Error(`HTTP ${statusCode}`), {statusCode, ...extra});

describe('isRetryable — retry the transport, never the reasoning', () => {
  it.each([408, 409, 429, 500, 502, 503, 504])('retries %d', status => {
    expect(isRetryable(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])('never retries %d', status => {
    // The same request fails the same way forever; paying three times for it
    // is strictly worse than failing once.
    expect(isRetryable(httpError(status))).toBe(false);
  });

  it('never retries a cancelled call', () => {
    expect(isRetryable(abortError(AbortReasons.CALLER_GONE))).toBe(false);
  });

  it('never retries an open circuit', () => {
    // Failing fast IS the breaker working; retrying just burns the budget.
    expect(isRetryable(new CircuitOpenError('m', 1000))).toBe(false);
  });

  it('honors an explicit isRetryable flag when there is no status', () => {
    expect(
      isRetryable(Object.assign(new Error('socket'), {isRetryable: true})),
    ).toBe(true);
    expect(isRetryable(new Error('probably our own bug'))).toBe(false);
  });
});

describe('retryPolicy', () => {
  it('retries a throttle and returns the eventual success', async () => {
    let calls = 0;
    const slept: number[] = [];
    const mw = retryPolicy({
      attempts: 3,
      baseDelayMs: 100,
      sleep: async ms => void slept.push(ms),
      jitter: () => 1,
    });
    const result = await drive(mw, async () => {
      if (++calls < 3) throw httpError(429);
      return {usage: undefined};
    });
    expect(calls).toBe(3);
    expect(result).toEqual({usage: undefined});
    // Exponential: 100, then 200.
    expect(slept).toEqual([100, 200]);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    let calls = 0;
    const mw = retryPolicy({
      attempts: 2,
      sleep: async () => {},
      jitter: () => 1,
    });
    await expect(
      drive(mw, async () => {
        calls++;
        throw httpError(503);
      }),
    ).rejects.toThrow('HTTP 503');
    expect(calls).toBe(2);
  });

  it('does not retry a client error — one attempt, one bill', async () => {
    let calls = 0;
    const mw = retryPolicy({attempts: 5, sleep: async () => {}});
    await expect(
      drive(mw, async () => {
        calls++;
        throw httpError(400);
      }),
    ).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('honors Retry-After over its own backoff', async () => {
    const slept: number[] = [];
    let calls = 0;
    const mw = retryPolicy({
      attempts: 2,
      baseDelayMs: 100,
      sleep: async ms => void slept.push(ms),
      jitter: () => 1,
    });
    await drive(mw, async () => {
      if (++calls === 1) {
        throw httpError(429, {responseHeaders: {'retry-after': '7'}});
      }
      return {};
    });
    expect(slept).toEqual([7000]);
  });

  it('jitters the backoff — a fleet must not retry in lockstep', async () => {
    const slept: number[] = [];
    let calls = 0;
    const mw = retryPolicy({
      attempts: 2,
      baseDelayMs: 1000,
      sleep: async ms => void slept.push(ms),
      jitter: () => 0.5,
    });
    await drive(mw, async () => {
      if (++calls === 1) throw httpError(500);
      return {};
    });
    expect(slept).toEqual([500]);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const slept: number[] = [];
    let calls = 0;
    const mw = retryPolicy({
      attempts: 4,
      baseDelayMs: 10_000,
      maxDelayMs: 15_000,
      sleep: async ms => void slept.push(ms),
      jitter: () => 1,
    });
    await expect(
      drive(mw, async () => {
        calls++;
        throw httpError(500);
      }),
    ).rejects.toThrow();
    expect(slept).toEqual([10_000, 15_000, 15_000]);
  });

  it('stops between attempts when the caller has gone', async () => {
    const controller = new AbortController();
    let calls = 0;
    const mw = retryPolicy({
      attempts: 5,
      sleep: async () => {
        // The caller hangs up while we are backing off.
        controller.abort(abortError(AbortReasons.CALLER_GONE));
      },
      jitter: () => 1,
    });
    await expect(
      drive(
        mw,
        async () => {
          calls++;
          throw httpError(503);
        },
        {abortSignal: controller.signal},
      ),
    ).rejects.toMatchObject({message: AbortReasons.CALLER_GONE});
    // One attempt, then the abort is noticed before spending again.
    expect(calls).toBe(1);
  });
});
