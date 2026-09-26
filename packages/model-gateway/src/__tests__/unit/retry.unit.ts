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

/**
 * A timeout the CALLER did not ask for — e.g. a provider `fetch` wrapper with
 * its own `AbortSignal.timeout`. Abort-shaped, but a transport failure.
 */
const transportTimeout = () =>
  new DOMException('The operation timed out.', 'TimeoutError');

describe('isRetryable — retry the transport, never the reasoning', () => {
  it.each([408, 409, 429, 500, 502, 503, 504])('retries %d', status => {
    expect(isRetryable(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 413, 422])('never retries %d', status => {
    // The same request fails the same way forever; paying three times for it
    // is strictly worse than failing once.
    expect(isRetryable(httpError(status))).toBe(false);
  });

  it('never retries a call the caller cancelled, whatever it threw', () => {
    const caller = AbortSignal.abort(abortError(AbortReasons.CALLER_GONE));
    expect(isRetryable(abortError(AbortReasons.CALLER_GONE), caller)).toBe(
      false,
    );
    // The AI SDK folds its own `timeout` into the caller's signal, so a
    // caller-side timeout surfaces as a TimeoutError on an aborted signal.
    expect(isRetryable(transportTimeout(), caller)).toBe(false);
  });

  it('retries an abort the caller did not ask for — it is the transport', () => {
    // The shape cannot say who aborted. A provider timeout is exactly the
    // "network having a bad second" this policy exists to retry.
    expect(isRetryable(transportTimeout())).toBe(true);
    expect(
      isRetryable(abortError('socket reset'), new AbortController().signal),
    ).toBe(true);
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

  it('retries a transport timeout and returns the eventual success', async () => {
    let calls = 0;
    const result = await drive(
      retryPolicy({sleep: async () => {}}),
      async () => {
        calls++;
        if (calls === 1) throw transportTimeout();
        return {text: 'ok'} as unknown as ModelGenerateResult;
      },
      {abortSignal: new AbortController().signal},
    );
    expect(result).toEqual({text: 'ok'});
    expect(calls).toBe(2);
  });

  it('does not retry once the caller has aborted — not even to sleep', async () => {
    let calls = 0;
    let slept = 0;
    const controller = new AbortController();
    await expect(
      drive(
        retryPolicy({
          sleep: async () => {
            slept++;
          },
        }),
        async () => {
          calls++;
          controller.abort(abortError(AbortReasons.CALLER_GONE));
          throw transportTimeout();
        },
        {abortSignal: controller.signal},
      ),
    ).rejects.toMatchObject({name: 'TimeoutError'});
    expect(calls).toBe(1);
    expect(slept).toBe(0);
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
