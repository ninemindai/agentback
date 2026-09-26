// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The load-bearing claim of this package: a gateway-wrapped model is a DROP-IN
// for the original, so `generateText`, `streamText`, `ToolLoopAgent` and
// `@agentback/agents` all route through the policies without knowing they
// exist. Proven against the real `wrapLanguageModel` and a mock provider —
// no network.

import {describe, expect, it} from 'vitest';
import {APICallError, generateText, streamText, ToolLoopAgent} from 'ai';
import {MockLanguageModelV4} from 'ai/test';
import {InMemoryUsageSink, Meter} from '@agentback/metering';
import {CircuitBreaker} from '../../breaker.js';
import {wrapModel} from '../../gateway.js';
import {withModelScope} from '../../scope.js';

const usage = {
  inputTokens: {total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0},
  outputTokens: {total: 10, text: 10, reasoning: 0},
  totalTokens: 50,
};

function okModel(text = 'hello') {
  return new MockLanguageModelV4({
    doGenerate: async () =>
      ({
        content: [{type: 'text' as const, text}],
        finishReason: 'stop' as const,
        usage,
        warnings: [],
      }) as never,
  });
}

const httpError = (statusCode: number) =>
  Object.assign(new Error(`HTTP ${statusCode}`), {statusCode});

describe('wrapModel (real AI SDK)', () => {
  it('is a drop-in for generateText', async () => {
    const model = await wrapModel(okModel('wrapped'), {retry: false});
    const result = await generateText({model, prompt: 'hi'});
    expect(result.text).toBe('wrapped');
  });

  it('meters a generateText call in tokens, under the ambient scope', async () => {
    const sink = new InMemoryUsageSink();
    const model = await wrapModel(okModel(), {
      accounting: {meter: new Meter(sink)},
      retry: false,
    });
    await withModelScope(
      {principal: {kind: 'user', id: 'u-7'}, correlationId: 'turn-1'},
      () => generateText({model, prompt: 'hi'}),
    );
    const [event] = sink.all();
    expect(event.units).toBe(50);
    expect(event.principal).toEqual({kind: 'user', id: 'u-7'});
    expect(event.meta?.correlationId).toBe('turn-1');
  });

  it('retries a throttled provider transparently to the caller', async () => {
    let attempts = 0;
    const flaky = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++attempts < 3) throw httpError(429);
        return {
          content: [{type: 'text' as const, text: 'eventually'}],
          finishReason: 'stop' as const,
          usage,
          warnings: [],
        } as never;
      },
    });
    const model = await wrapModel(flaky, {
      retry: {attempts: 3, sleep: async () => {}, jitter: () => 1},
    });
    const result = await generateText({model, prompt: 'hi'});
    expect(result.text).toBe('eventually');
    expect(attempts).toBe(3);
  });

  it('bills ONE event for a call that took three attempts', async () => {
    const sink = new InMemoryUsageSink();
    let attempts = 0;
    const flaky = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++attempts < 3) throw httpError(503);
        return {
          content: [{type: 'text' as const, text: 'ok'}],
          finishReason: 'stop' as const,
          usage,
          warnings: [],
        } as never;
      },
    });
    const model = await wrapModel(flaky, {
      accounting: {meter: new Meter(sink)},
      retry: {attempts: 3, sleep: async () => {}, jitter: () => 1},
    });
    await generateText({model, prompt: 'hi'});
    // Accounting sits OUTSIDE retry, so one logical call bills once.
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0].units).toBe(50);
  });

  it('the AI SDK does not re-retry what the gateway already retried', async () => {
    const sink = new InMemoryUsageSink();
    let calls = 0;
    const overloaded = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++;
        // The real shape: the SDK re-retries any APICallError marked
        // retryable, which is exactly what a provider 503 is.
        throw new APICallError({
          message: 'Service Unavailable',
          url: 'https://provider.test/v1',
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      },
    });
    const model = await wrapModel(overloaded, {
      accounting: {meter: new Meter(sink)},
      retry: {sleep: async () => {}},
    });
    // Default `maxRetries`: the path every caller takes unless told otherwise.
    const err = await generateText({model, prompt: 'hi'}).catch(e => e);
    // Three attempts, not nine: a sick provider must not see the gateway's
    // retries multiplied by the SDK's.
    expect(calls).toBe(3);
    expect(sink.all()).toHaveLength(1);
    // Still the provider's own error, so callers can inspect it.
    expect(APICallError.isInstance(err)).toBe(true);
    expect(err.statusCode).toBe(503);
  });

  it('falls over to a second provider when the first is down', async () => {
    const dead = new MockLanguageModelV4({
      doGenerate: async () => {
        throw httpError(503);
      },
    });
    const model = await wrapModel(dead, {
      fallback: {models: [okModel('from the backup')]},
      retry: {attempts: 2, sleep: async () => {}, jitter: () => 1},
    });
    const result = await generateText({model, prompt: 'hi'});
    expect(result.text).toBe('from the backup');
  });

  it('a secondary is called raw, so give it its own retry by wrapping it', async () => {
    const dead = new MockLanguageModelV4({
      doGenerate: async () => {
        throw httpError(503);
      },
    });
    /** A backup that is throttled once, then answers. */
    const throttledOnce = () => {
      let calls = 0;
      return new MockLanguageModelV4({
        modelId: 'backup',
        doGenerate: async options => {
          if (++calls === 1) throw httpError(429);
          return okModel('from the backup').doGenerate(options);
        },
      });
    };
    const primary = {retry: {attempts: 1}} as const;

    // Raw: the fallback policy calls it once, and one 429 ends the call.
    const bare = await wrapModel(dead, {
      ...primary,
      fallback: {models: [throttledOnce()]},
    });
    await expect(generateText({model: bare, prompt: 'hi'})).rejects.toThrow(
      'HTTP 429',
    );

    // Wrapped with `accounting: false` (the primary already bills it), the
    // secondary retries its own throttle and answers.
    const backup = await wrapModel(throttledOnce(), {
      accounting: false,
      retry: {sleep: async () => {}},
    });
    const model = await wrapModel(dead, {
      ...primary,
      fallback: {models: [backup]},
    });
    const result = await generateText({model, prompt: 'hi'});
    expect(result.text).toBe('from the backup');
  });

  it('bills a failed-over call to the model that actually served it', async () => {
    const sink = new InMemoryUsageSink();
    const dead = new MockLanguageModelV4({
      doGenerate: async () => {
        throw httpError(503);
      },
      doStream: async () => {
        throw httpError(503);
      },
    });
    const backup = new MockLanguageModelV4({
      provider: 'backup-provider',
      modelId: 'backup-model',
      doGenerate: okModel('from the backup').doGenerate,
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({type: 'text-start', id: '1'});
              controller.enqueue({type: 'text-delta', id: '1', delta: 'b'});
              controller.enqueue({type: 'text-end', id: '1'});
              controller.enqueue({type: 'finish', finishReason: 'stop', usage});
              controller.close();
            },
          }),
        }) as never,
    });
    const model = await wrapModel(dead, {
      accounting: {meter: new Meter(sink)},
      fallback: {models: [backup]},
      retry: {attempts: 1},
    });
    await generateText({model, prompt: 'hi'});
    expect(await streamText({model, prompt: 'hi'}).text).toBe('b');
    // Spend belongs to whoever sent the bill, not to the model that failed.
    expect(sink.all().map(e => e.meta?.model)).toEqual([
      'backup-provider:backup-model',
      'backup-provider:backup-model',
    ]);
  });

  it('trips the breaker, then fails over immediately without calling', async () => {
    let primaryCalls = 0;
    const dead = new MockLanguageModelV4({
      doGenerate: async () => {
        primaryCalls++;
        throw httpError(503);
      },
    });
    const breaker = new CircuitBreaker({threshold: 2, resetAfterMs: 60_000});
    const model = await wrapModel(dead, {
      fallback: {models: [okModel('backup')]},
      retry: {attempts: 1, sleep: async () => {}, jitter: () => 1},
      breaker,
    });

    await generateText({model, prompt: 'a'});
    await generateText({model, prompt: 'b'});
    expect(primaryCalls).toBe(2);
    expect(breaker.state('mock-provider:mock-model-id')).toBe('open');

    // Third call: the circuit is open, so the primary is not touched at all
    // and the secondary answers immediately.
    const result = await generateText({model, prompt: 'c'});
    expect(result.text).toBe('backup');
    expect(primaryCalls).toBe(2);
  });

  it('meters a streamed call once the stream drains', async () => {
    const sink = new InMemoryUsageSink();
    const streaming = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({type: 'text-start', id: '1'});
              controller.enqueue({type: 'text-delta', id: '1', delta: 'hi'});
              controller.enqueue({type: 'text-end', id: '1'});
              controller.enqueue({type: 'finish', finishReason: 'stop', usage});
              controller.close();
            },
          }),
        }) as never,
    });
    const model = await wrapModel(streaming, {
      accounting: {meter: new Meter(sink)},
      retry: false,
    });
    const result = streamText({model, prompt: 'hi'});
    expect(await result.text).toBe('hi');
    expect(sink.all()[0].units).toBe(50);
  });

  it('a ToolLoopAgent built on a wrapped model is metered per turn', async () => {
    const sink = new InMemoryUsageSink();
    const model = await wrapModel(okModel('done'), {
      accounting: {meter: new Meter(sink)},
      retry: false,
    });
    const agent = new ToolLoopAgent({model, tools: {}});
    await withModelScope({principal: {kind: 'user', id: 'u-9'}}, () =>
      agent.generate({prompt: 'go'}),
    );
    expect(sink.all()).toHaveLength(1);
    expect(sink.all()[0].units).toBe(50);
    expect(sink.all()[0].principal).toEqual({kind: 'user', id: 'u-9'});
  });
});
