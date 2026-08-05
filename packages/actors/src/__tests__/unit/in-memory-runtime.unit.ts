// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {enableDebug, LogLevel, onLog} from '@agentback/common';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {TurnTimeoutError} from '../../deadlines.js';
import {defineActor} from '../../define-actor.js';
import {InMemoryActorRuntime} from '../../in-memory-runtime.js';
import {runActorRuntimeConformance} from '../../testing/conformance.js';

runActorRuntimeConformance('in-memory', () => new InMemoryActorRuntime());

/**
 * Collect deadline-namespace warn/error records while `fn` runs.
 *
 * `log.warn(...)` is a no-op unless its debug namespace is enabled (the
 * `debug` package's own gate, which `onLog` hooks sit behind), so this enables
 * it — and restores it afterwards, so the surrounding conformance cases stay
 * quiet rather than logging a wall of expected timeouts.
 */
async function captureDeadlineLogs(
  fn: () => Promise<void>,
): Promise<{level: LogLevel; args: unknown[]}[]> {
  const captured: {level: LogLevel; args: unknown[]}[] = [];
  const previous = process.env.DEBUG ?? '';
  const dispose = onLog((namespace, level, args) => {
    if (namespace.startsWith('agentback:actors:deadline')) {
      captured.push({level, args});
    }
  });
  enableDebug('agentback:actors:deadline:*');
  try {
    await fn();
  } finally {
    dispose();
    enableDebug(previous);
  }
  return captured;
}

function hangingActor(name: string) {
  return defineActor(name, {
    state: z.object({}),
    command: z.object({}),
    result: z.object({}),
    deadlineMs: 50,
    initialState: () => ({}),
    async receive() {
      await new Promise<never>(() => {});
      throw new Error('unreachable');
    },
  });
}

describe('InMemoryActorRuntime deadlines', () => {
  // This runtime has no journal, so the failed-turn record a journaling
  // runtime writes as an `actor.turn.timeout` entry is, here, the log line —
  // emitted by the same shared `logTimedOutTurn` all three runtimes call.
  it('records a timed-out turn in the log', async () => {
    const runtime = new InMemoryActorRuntime();
    const definition = hangingActor('in-memory-deadline');
    runtime.register(definition);

    const captured = await captureDeadlineLogs(async () => {
      await expect(
        runtime.ref(definition, 'wedged').invoke({}, {requestId: 'hangs'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.level).toBe(LogLevel.WARN);
    // The record identifies the turn: actor type, id, requestId, deadline.
    expect(captured[0]?.args).toEqual(
      expect.arrayContaining(['in-memory-deadline', 'wedged', 'hangs', 50]),
    );
  });

  // The journal-free analogue of "exactly ONE marker, on the inner actor's
  // log": one incident crossing two turn frames must still produce one record,
  // naming the identity whose deadline actually fired.
  it('records a nested timeout once, naming the inner turn', async () => {
    const runtime = new InMemoryActorRuntime();
    const inner = hangingActor('in-memory-deadline-inner');
    const outer = defineActor('in-memory-deadline-outer', {
      state: z.object({}),
      command: z.object({}),
      result: z.object({}),
      deadlineMs: 5_000,
      initialState: () => ({}),
      async receive(_ctx, state) {
        await runtime.ref(inner, 'hangs').invoke({}, {requestId: 'nested'});
        return {state, result: {}};
      },
    });
    runtime.register(inner);
    runtime.register(outer);

    const captured = await captureDeadlineLogs(async () => {
      await expect(
        runtime.ref(outer, 'caller').invoke({}, {requestId: 'outer-call'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.args).toEqual(
      expect.arrayContaining(['in-memory-deadline-inner', 'hangs', 'nested']),
    );
  });
});

describe('InMemoryActorRuntime ordering', () => {
  it('runs turns for one identity in submission order (FIFO)', async () => {
    const runtime = new InMemoryActorRuntime();
    const State = z.object({log: z.array(z.string())});
    const definition = defineActor('fifo', {
      state: State,
      command: z.object({tag: z.string(), waitMs: z.number().default(0)}),
      result: State,
      initialState: () => ({log: []}),
      async receive(_ctx, state, command) {
        if (command.waitMs) {
          await new Promise<void>(resolve =>
            setTimeout(resolve, command.waitMs),
          );
        }
        state.log.push(command.tag);
        return {state, result: state};
      },
    });
    runtime.register(definition);
    const ref = runtime.ref(definition, 'one');

    // Despite the first turn sleeping longest, the in-memory mailbox is a
    // promise chain keyed by identity, so turns commit in submission order.
    await Promise.all([
      ref.invoke({tag: 'a', waitMs: 20}),
      ref.invoke({tag: 'b', waitMs: 0}),
      ref.invoke({tag: 'c', waitMs: 0}),
    ]);

    expect(await runtime.state(definition, 'one')).toEqual({
      log: ['a', 'b', 'c'],
    });
  });
});

describe('InMemoryActorRuntime dedup bound', () => {
  const State = z.object({value: z.number()});
  function counter(onTurn: () => void) {
    return defineActor('bounded', {
      state: State,
      command: z.object({}),
      result: State,
      initialState: () => ({value: 0}),
      receive(_ctx, state) {
        onTurn();
        state.value += 1;
        return {state, result: state};
      },
    });
  }

  it('rejects a non-positive dedupLimit', () => {
    expect(() => new InMemoryActorRuntime({dedupLimit: 0})).toThrow(
      'dedupLimit',
    );
  });

  it('evicts the oldest requestId and re-runs it on replay', async () => {
    const runtime = new InMemoryActorRuntime({dedupLimit: 2});
    let turns = 0;
    const definition = counter(() => turns++);
    runtime.register(definition);
    const ref = runtime.ref(definition, 'one');

    await ref.invoke({}, {requestId: 'r1'});
    await ref.invoke({}, {requestId: 'r2'});
    await ref.invoke({}, {requestId: 'r3'}); // evicts r1 (oldest)
    expect(turns).toBe(3);

    // r3 is still retained, so its replay is deduplicated (no re-run)...
    await ref.invoke({}, {requestId: 'r3'});
    expect(turns).toBe(3);

    // ...but r1 was evicted, so replaying it runs the command again.
    await ref.invoke({}, {requestId: 'r1'});
    expect(turns).toBe(4);
  });
});
