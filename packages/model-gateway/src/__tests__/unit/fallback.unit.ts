// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {AbortReasons, abortError} from '@agentback/common';
import {CircuitOpenError} from '../../errors.js';
import {fallbackPolicy} from '../../fallback.js';
import type {LanguageModelLike, ModelGenerateResult} from '../../types.js';

const PRIMARY = {modelId: 'primary', provider: 'p'} as LanguageModelLike;

const httpError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), {statusCode});

/** A stand-in secondary that records the call and answers with its name. */
function givenSecondary(name: string, fails?: unknown) {
  const calls: unknown[] = [];
  const model = {
    modelId: name,
    provider: 'p',
    async doGenerate(params: unknown) {
      calls.push(params);
      if (fails) throw fails;
      return {answeredBy: name};
    },
    async doStream(params: unknown) {
      calls.push(params);
      if (fails) throw fails;
      return {answeredBy: name};
    },
  } as unknown as LanguageModelLike;
  return {model, calls};
}

async function drive(
  models: LanguageModelLike[],
  doGenerate: () => PromiseLike<ModelGenerateResult>,
  params: Record<string, unknown> = {p: 1},
) {
  return fallbackPolicy({models}).wrapGenerate!({
    doGenerate,
    doStream: () => Promise.resolve({}),
    params,
    model: PRIMARY,
  });
}

describe('fallbackPolicy', () => {
  it('does not touch the secondary when the primary answers', async () => {
    const b = givenSecondary('backup');
    const result = await drive([b.model], async () => ({ok: true}));
    expect(result).toEqual({ok: true});
    expect(b.calls).toHaveLength(0);
  });

  it('fails over on a provider failure, forwarding the same params', async () => {
    const b = givenSecondary('backup');
    const result = await drive([b.model], async () => {
      throw httpError(503);
    });
    expect(result).toEqual({answeredBy: 'backup'});
    expect(b.calls).toEqual([{p: 1}]);
  });

  it('fails over on an open circuit — that is what a secondary is for', async () => {
    const b = givenSecondary('backup');
    const result = await drive([b.model], async () => {
      throw new CircuitOpenError('p:primary', 30_000);
    });
    expect(result).toEqual({answeredBy: 'backup'});
  });

  it('walks the whole chain until one answers', async () => {
    const first = givenSecondary('first', httpError(500));
    const second = givenSecondary('second');
    const result = await drive([first.model, second.model], async () => {
      throw httpError(503);
    });
    expect(result).toEqual({answeredBy: 'second'});
    expect(first.calls).toHaveLength(1);
  });

  it('does NOT fail over on a malformed request', async () => {
    const b = givenSecondary('backup');
    // A 400 fails identically everywhere; a second provider just buys the
    // same rejection twice, at twice the latency.
    await expect(
      drive([b.model], async () => {
        throw httpError(400);
      }),
    ).rejects.toThrow('HTTP 400');
    expect(b.calls).toHaveLength(0);
  });

  it('still fails over on a 429 — throttling is about the provider, not the request', async () => {
    const b = givenSecondary('backup');
    await expect(
      drive([b.model], async () => {
        throw httpError(429);
      }),
    ).resolves.toEqual({answeredBy: 'backup'});
  });

  it('does NOT fail over a cancelled call', async () => {
    const b = givenSecondary('backup');
    // The caller left. Asking a second provider is spending money on an
    // answer nobody is waiting for.
    await expect(
      drive([b.model], async () => {
        throw abortError(AbortReasons.CALLER_GONE);
      }),
    ).rejects.toMatchObject({name: 'AbortError'});
    expect(b.calls).toHaveLength(0);
  });

  it('rethrows the last failure when the whole chain is down', async () => {
    const b = givenSecondary('backup', httpError(502));
    await expect(
      drive([b.model], async () => {
        throw httpError(503);
      }),
    ).rejects.toThrow('HTTP 502');
  });
});
