// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {enableDebug, onLog} from '@agentback/common';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {defineActor} from '../../define-actor.js';
import {EventSourcedActorRuntime} from '../../event-sourced-runtime.js';
import {
  runActorEventStoreConformance,
  runActorRuntimeConformance,
} from '../../testing/conformance.js';
import type {CommittedActorEvent} from '../../types.js';

// It is a conformant ActorRuntime first (serialization, rollback, dedup, …).
runActorRuntimeConformance(
  'event-sourced',
  () => new EventSourcedActorRuntime(),
);
// …and the reference implementation of the journal contract every durable
// event-log adapter must also satisfy.
runActorEventStoreConformance(
  'event-sourced',
  () => new EventSourcedActorRuntime(),
);

describe('EventSourcedActorRuntime events', () => {
  const State = z.object({count: z.number()});
  const Command = z.discriminatedUnion('type', [
    z.object({type: z.literal('inc'), by: z.number()}),
    z.object({type: z.literal('boom')}),
  ]);

  function counter() {
    return defineActor('es.counter', {
      state: State,
      command: Command,
      result: State,
      initialState: () => ({count: 0}),
      receive(_ctx, state, command) {
        if (command.type === 'boom') {
          state.count = 999;
          throw new Error('turn failed');
        }
        state.count += command.by;
        return {
          state,
          result: state,
          events: [{type: 'Incremented', by: command.by}],
        };
      },
    });
  }

  // Append/ordering/rollback/replay live in the shared journal conformance
  // above; what is unique to this runtime is in-process delivery.
  it('delivers each committed event to subscribers until they unsubscribe', async () => {
    const runtime = new EventSourcedActorRuntime();
    const definition = counter();
    runtime.register(definition);
    const seen: CommittedActorEvent[] = [];
    const unsubscribe = runtime.subscribe(event => {
      seen.push(event);
    });

    const ref = runtime.ref(definition, 'a');
    await ref.invoke({type: 'inc', by: 3});
    await ref.invoke({type: 'inc', by: 2});

    // The subscriber saw the same events, in the same order, as the log.
    const log = await runtime.events('es.counter', 'a');
    expect(seen.map(e => e.event)).toEqual(log.map(e => e.event));
    expect(seen.map(e => e.seq)).toEqual([0, 1]);

    unsubscribe();
    await ref.invoke({type: 'inc', by: 1});
    expect(seen).toHaveLength(2); // no more after unsubscribe
  });

  it('logs and skips a subscriber whose async handler rejects', async () => {
    // `subscribe`'s handler type accepts an async function, and the port
    // documents a failing subscriber as "logged and skipped". A per-subscriber
    // try/catch only catches synchronous throws, so an async rejection used to
    // escape as an unhandled rejection: neither logged, nor visibly skipped.
    const runtime = new EventSourcedActorRuntime();
    const definition = counter();
    runtime.register(definition);

    const sibling: CommittedActorEvent[] = [];
    runtime.subscribe(async () => {
      await Promise.resolve();
      throw new Error('async subscriber exploded');
    });
    runtime.subscribe(event => {
      sibling.push(event);
    });

    const logged: unknown[][] = [];
    const previous = process.env.DEBUG ?? '';
    const dispose = onLog((namespace, _level, args) => {
      if (namespace.startsWith('agentback:actors:events')) logged.push(args);
    });
    enableDebug('agentback:actors:events:*');
    try {
      // The committing turn is unaffected: it returns its result normally.
      const result = await runtime
        .ref(definition, 'async-subscriber')
        .invoke({type: 'inc', by: 2});
      expect(result).toEqual({count: 2});
      // Let the rejection settle before asserting on the log.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    } finally {
      dispose();
      enableDebug(previous);
    }

    // The sibling still got its event, and the failure was recorded.
    expect(sibling.map(e => e.event)).toEqual([{type: 'Incremented', by: 2}]);
    expect(logged.some(args => String(args[0]).includes('was skipped'))).toBe(
      true,
    );

    // And the log is intact — delivery never touches the commit.
    expect(await runtime.events('es.counter', 'async-subscriber')).toHaveLength(
      1,
    );
  });

  it('does not deliver events from a turn that rolls back', async () => {
    const runtime = new EventSourcedActorRuntime();
    const definition = counter();
    runtime.register(definition);
    const seen: CommittedActorEvent[] = [];
    runtime.subscribe(event => {
      seen.push(event);
    });

    await expect(
      runtime.ref(definition, 'b').invoke({type: 'boom'}),
    ).rejects.toThrow('turn failed');

    expect(seen).toEqual([]);
  });
});
