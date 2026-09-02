// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {CircuitBreaker, breakerPolicy} from '../../breaker.js';
import {CircuitOpenError} from '../../errors.js';
import type {LanguageModelLike, ModelGenerateResult} from '../../types.js';

const MODEL = {modelId: 'm', provider: 'p'} as LanguageModelLike;
const TARGET = 'p:m';

const httpError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), {statusCode});

function givenBreaker(nowRef: {t: number}, threshold = 3, resetAfterMs = 1000) {
  const breaker = new CircuitBreaker({
    threshold,
    resetAfterMs,
    now: () => nowRef.t,
  });
  const mw = breakerPolicy(breaker);
  const call = async (doGenerate: () => PromiseLike<ModelGenerateResult>) =>
    mw.wrapGenerate!({
      doGenerate,
      doStream: () => Promise.resolve({}),
      params: {},
      model: MODEL,
    });
  return {breaker, call};
}

const fail =
  (status = 503) =>
  async (): Promise<ModelGenerateResult> => {
    throw httpError(status);
  };
const succeed = async (): Promise<ModelGenerateResult> => ({});

describe('CircuitBreaker', () => {
  it('stays closed below the threshold', async () => {
    const now = {t: 0};
    const {breaker, call} = givenBreaker(now);
    await expect(call(fail())).rejects.toThrow('HTTP 503');
    await expect(call(fail())).rejects.toThrow('HTTP 503');
    expect(breaker.state(TARGET)).toBe('closed');
  });

  it('trips at the threshold and then refuses to call at all', async () => {
    const now = {t: 0};
    const {breaker, call} = givenBreaker(now);
    for (let i = 0; i < 3; i++) await call(fail()).catch(() => {});
    expect(breaker.state(TARGET)).toBe('open');

    let reached = false;
    await expect(
      call(async () => {
        reached = true;
        return {};
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    // The point of the breaker: the provider is not touched at all.
    expect(reached).toBe(false);
  });

  it('a success resets the consecutive-failure count', async () => {
    const now = {t: 0};
    const {breaker, call} = givenBreaker(now);
    await call(fail()).catch(() => {});
    await call(fail()).catch(() => {});
    await call(succeed);
    await call(fail()).catch(() => {});
    await call(fail()).catch(() => {});
    // Only two consecutive failures since the success — still closed.
    expect(breaker.state(TARGET)).toBe('closed');
  });

  it('lets exactly ONE probe through when half-open', async () => {
    const now = {t: 0};
    const {breaker, call} = givenBreaker(now);
    for (let i = 0; i < 3; i++) await call(fail()).catch(() => {});
    now.t = 1000; // cooldown elapsed
    expect(breaker.state(TARGET)).toBe('half-open');

    // Hold the probe open so a second caller races it.
    let releaseProbe!: () => void;
    const probe = call(
      () => new Promise<ModelGenerateResult>(r => (releaseProbe = () => r({}))),
    );
    // Releasing the whole backlog at once is how a recovering provider gets
    // knocked over a second time.
    await expect(call(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
    releaseProbe();
    await probe;
    expect(breaker.state(TARGET)).toBe('closed');
  });

  it('a failed probe restarts the cooldown instead of probing in a loop', async () => {
    const now = {t: 0};
    const {breaker, call} = givenBreaker(now);
    for (let i = 0; i < 3; i++) await call(fail()).catch(() => {});
    now.t = 1000;
    await call(fail()).catch(() => {});
    expect(breaker.state(TARGET)).toBe('open');
    now.t = 1999;
    expect(breaker.state(TARGET)).toBe('open');
    now.t = 2000;
    expect(breaker.state(TARGET)).toBe('half-open');
  });

  it('a client error never trips the circuit', async () => {
    const now = {t: 0};
    const {breaker, call} = givenBreaker(now);
    // One caller's malformed request must not take the provider away from
    // everyone else.
    for (let i = 0; i < 10; i++) await call(fail(400)).catch(() => {});
    expect(breaker.state(TARGET)).toBe('closed');
  });

  it('a client error during a probe releases the probe slot', async () => {
    const now = {t: 0};
    const {breaker, call} = givenBreaker(now);
    for (let i = 0; i < 3; i++) await call(fail()).catch(() => {});
    now.t = 1000;
    // The probe is answered with a 400 — neutral, not evidence either way.
    await expect(call(fail(400))).rejects.toThrow('HTTP 400');
    // Without releasing the slot the circuit would wedge shut forever.
    expect(breaker.state(TARGET)).toBe('half-open');
    await call(succeed);
    expect(breaker.state(TARGET)).toBe('closed');
  });

  it('tracks circuits per target', async () => {
    const now = {t: 0};
    const breaker = new CircuitBreaker({threshold: 2, now: () => now.t});
    const mw = breakerPolicy(breaker);
    const callOn = async (model: LanguageModelLike) => {
      try {
        await mw.wrapGenerate!({
          doGenerate: fail(),
          doStream: () => Promise.resolve({}),
          params: {},
          model,
        });
      } catch {
        // expected
      }
    };
    const a = {modelId: 'a', provider: 'p'} as LanguageModelLike;
    const b = {modelId: 'b', provider: 'p'} as LanguageModelLike;
    await callOn(a);
    await callOn(a);
    expect(breaker.state('p:a')).toBe('open');
    expect(breaker.state('p:b')).toBe('closed');
  });
});
