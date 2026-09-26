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
  ModelStreamResult,
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

  it('counts a nested scope against every enclosing budget', async () => {
    const {sink, generate} = givenPolicy();
    let calls = 0;
    const outer = await withModelScope({tokenBudget: 60}, async () => {
      // A nested turn: its own principal and correlation id, no budget of its
      // own. Its spend must not escape the budget of the work it runs inside.
      await withModelScope(
        {principal: {kind: 'user', id: 'inner'}, correlationId: 'turn-inner'},
        async () => {
          const count = async () => {
            calls++;
            return generate(usageOf(40, 10));
          };
          await count(); // 50 of 60
          await count(); // 100: admitted at 50, the one-response overshoot
          await expect(count()).rejects.toBeInstanceOf(
            TokenBudgetExceededError,
          );
        },
      );
      return currentModelScope()!;
    });
    expect(calls).toBe(3);
    expect(outer.tokensSpent).toBe(100);
    // A nested turn is still its own turn.
    expect(sink.all()[0].principal).toEqual({kind: 'user', id: 'inner'});
    expect(sink.all()[0].meta?.correlationId).toBe('turn-inner');
  });

  it('each concurrent call may overshoot by one response, then the scope refuses', async () => {
    const mw = accountingPolicy({});
    let calls = 0;
    await withModelScope({tokenBudget: 1}, async () => {
      const count = () =>
        mw.wrapGenerate!({
          doGenerate: async () => {
            calls++;
            await new Promise(r => setTimeout(r, 5));
            return {usage: usageOf(90, 10)};
          },
          doStream: () => Promise.resolve({}),
          params: {},
          model: MODEL,
        });
      // Calls in flight together all pass the pre-call check before any of
      // them has reported spend. That is the bound: one response per call.
      await Promise.all(Array.from({length: 5}, count));
      expect(currentModelScope()!.tokensSpent).toBe(500);
      await expect(count()).rejects.toBeInstanceOf(TokenBudgetExceededError);
    });
    expect(calls).toBe(5); // the sixth never reached the provider
  });

  it('records a budget refusal on the scope, for callers that only see a stream', async () => {
    const {generate} = givenPolicy();
    const scope = await withModelScope({tokenBudget: 1}, async () => {
      await generate(usageOf(1, 0));
      await generate(usageOf(1, 0)).catch(() => {});
      return currentModelScope()!;
    });
    expect(scope.refused).toBeInstanceOf(TokenBudgetExceededError);
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

  describe('streams', () => {
    const U1 = {kind: 'user' as const, id: 'u-1'};

    function givenStream(doStream: () => PromiseLike<ModelStreamResult>) {
      const sink = new InMemoryUsageSink();
      const mw = accountingPolicy({meter: new Meter(sink)});
      const open = () =>
        mw.wrapStream!({
          doGenerate: () => Promise.resolve({}),
          doStream,
          params: {},
          model: MODEL,
        }) as Promise<{stream: ReadableStream<unknown>}>;
      return {sink, open};
    }

    const drain = async (stream: ReadableStream<unknown>) => {
      for await (const _part of stream as unknown as AsyncIterable<unknown>);
    };
    const tick = () => new Promise(r => setTimeout(r, 10));

    it('records a stream that could not be opened', async () => {
      const {sink, open} = givenStream(async () => {
        throw Object.assign(new Error('HTTP 503'), {statusCode: 503});
      });
      await expect(withModelScope({principal: U1}, open)).rejects.toThrow(
        'HTTP 503',
      );
      await tick();
      expect(sink.all()).toHaveLength(1);
      expect(sink.all()[0]).toMatchObject({
        status: 'error',
        units: 0,
        principal: U1,
      });
    });

    it('bills a consumer cancel to the scope the call was made in', async () => {
      const {sink, open} = givenStream(async () => {
        let sent = 0;
        return {
          stream: new ReadableStream({
            pull(controller) {
              controller.enqueue(
                sent++ === 0
                  ? {type: 'finish', usage: usageOf(90, 10)}
                  : {type: 'text-delta', delta: 'x'},
              );
            },
          }),
        };
      });
      let scope: ReturnType<typeof currentModelScope>;
      const result = await withModelScope({principal: U1}, () => {
        scope = currentModelScope();
        return open();
      });
      // The consumer reads, then walks away OUTSIDE the scope, which is where
      // a streamed response is usually consumed.
      const reader = result.stream.getReader();
      await reader.read();
      await reader.cancel('bye');
      await tick();
      expect(sink.all()[0]).toMatchObject({
        status: 'error',
        units: 100,
        principal: U1,
      });
      expect(scope!.tokensSpent).toBe(100);
    });

    it.each([
      ['carried an error part', [{type: 'error', error: 'overloaded'}]],
      ['ended without a finish part', [{type: 'text-delta', delta: 'hi'}]],
    ])('a stream that %s is not recorded as ok', async (_why, parts) => {
      const {sink, open} = givenStream(async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      }));
      await drain((await open()).stream);
      await tick();
      expect(sink.all()[0].status).toBe('error');
    });
  });
});
