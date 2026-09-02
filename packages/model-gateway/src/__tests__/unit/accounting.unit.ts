// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {InMemoryUsageSink, Meter} from '@agentback/metering';
import {accountingPolicy} from '../../accounting.js';
import {TokenBudgetExceededError} from '../../errors.js';
import {currentModelScope, withModelScope} from '../../scope.js';
import type {
  LanguageModelLike,
  ModelGenerateResult,
  ModelUsage,
} from '../../types.js';

const MODEL = {modelId: 'sonnet', provider: 'anthropic'} as LanguageModelLike;

const usageOf = (input: number, output: number): ModelUsage => ({
  inputTokens: {total: input},
  outputTokens: {total: output},
});

function givenPolicy() {
  const sink = new InMemoryUsageSink();
  const meter = new Meter(sink);
  const mw = accountingPolicy({meter});
  const generate = async (usage?: ModelUsage): Promise<ModelGenerateResult> =>
    mw.wrapGenerate!({
      doGenerate: async () => ({usage}),
      doStream: () => Promise.resolve({}),
      params: {},
      model: MODEL,
    });
  return {sink, mw, generate};
}

describe('token accounting', () => {
  it('bills units in TOKENS, not calls', async () => {
    const {sink, generate} = givenPolicy();
    await generate(usageOf(1200, 300));
    const [event] = sink.all();
    // One request can be 500 tokens or 500,000 — a per-call counter describes
    // traffic and says nothing about spend.
    expect(event.units).toBe(1500);
    expect(event.surface).toBe('agent');
    expect(event.operation).toBe('model.call');
    expect(event.meta).toMatchObject({
      model: 'anthropic:sonnet',
      inputTokens: 1200,
      outputTokens: 300,
    });
  });

  it('attributes to the ambient scope principal and correlation id', async () => {
    const {sink, generate} = givenPolicy();
    await withModelScope(
      {
        principal: {kind: 'user', id: 'u-1'},
        correlationId: 'turn-9',
      },
      () => generate(usageOf(10, 5)),
    );
    const [event] = sink.all();
    expect(event.principal).toEqual({kind: 'user', id: 'u-1'});
    expect(event.meta?.correlationId).toBe('turn-9');
  });

  it('bills anonymously outside a scope rather than failing', async () => {
    const {sink, generate} = givenPolicy();
    await generate(usageOf(10, 5));
    expect(sink.all()[0].principal).toEqual({kind: 'anonymous', id: 'anon'});
  });

  it('accumulates spend across calls within one scope', async () => {
    const {generate} = givenPolicy();
    const spent = await withModelScope({}, async () => {
      await generate(usageOf(100, 50));
      await generate(usageOf(200, 25));
      return currentModelScope()!.tokensSpent;
    });
    expect(spent).toBe(375);
  });

  it('keeps sibling scopes isolated', async () => {
    const {generate} = givenPolicy();
    const [a, b] = await Promise.all([
      withModelScope({}, async () => {
        await generate(usageOf(100, 0));
        return currentModelScope()!.tokensSpent;
      }),
      withModelScope({}, async () => {
        await generate(usageOf(7, 0));
        return currentModelScope()!.tokensSpent;
      }),
    ]);
    expect([a, b]).toEqual([100, 7]);
  });

  it('refuses a call once the budget is spent — a bounded failure beats an unbounded bill', async () => {
    const {generate} = givenPolicy();
    let calls = 0;
    await withModelScope({tokenBudget: 500}, async () => {
      const count = async () => {
        calls++;
        return generate(usageOf(400, 100));
      };
      await count(); // spends exactly 500
      await expect(count()).rejects.toBeInstanceOf(TokenBudgetExceededError);
    });
    expect(calls).toBe(2); // the second threw before reaching the provider
  });

  it('records a failed call without inventing token counts', async () => {
    const sink = new InMemoryUsageSink();
    const mw = accountingPolicy({meter: new Meter(sink)});
    await expect(
      mw.wrapGenerate!({
        doGenerate: async () => {
          throw new Error('provider exploded');
        },
        doStream: () => Promise.resolve({}),
        params: {},
        model: MODEL,
      }),
    ).rejects.toThrow('provider exploded');
    const [event] = sink.all();
    expect(event.status).toBe('error');
    expect(event.units).toBe(0);
  });

  it('taps a stream and bills the usage from its finish part', async () => {
    const sink = new InMemoryUsageSink();
    const mw = accountingPolicy({meter: new Meter(sink)});
    const parts = [
      {type: 'text-delta', delta: 'hi'},
      {type: 'finish', usage: usageOf(90, 10)},
    ];
    const result = (await mw.wrapStream!({
      doGenerate: () => Promise.resolve({}),
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      }),
      params: {},
      model: MODEL,
    })) as {stream: ReadableStream<unknown>};

    // Streaming is the common case for an agent; metering that skipped it
    // would miss most of the bill. Nothing is recorded until the stream drains.
    expect(sink.all()).toHaveLength(0);
    const seen: unknown[] = [];
    for await (const part of result.stream as unknown as AsyncIterable<unknown>) {
      seen.push(part);
    }
    expect(seen).toEqual(parts); // the tap is transparent
    expect(sink.all()[0].units).toBe(100);
  });
});
