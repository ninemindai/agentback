// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {defineActor} from '../../define-actor.js';
import {EventSourcedActorRuntime} from '../../event-sourced-runtime.js';
import {runActorRuntimeConformance} from '../../testing/conformance.js';
import type {CommittedActorEvent} from '../../types.js';

// It is a conformant ActorRuntime first (serialization, rollback, dedup, …).
runActorRuntimeConformance(
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

  it('appends events atomically and exposes the ordered log', async () => {
    const runtime = new EventSourcedActorRuntime();
    const definition = counter();
    runtime.register(definition);
    const seen: CommittedActorEvent[] = [];
    const unsubscribe = runtime.subscribe(event => seen.push(event));

    const ref = runtime.ref(definition, 'a');
    await ref.invoke({type: 'inc', by: 3});
    await ref.invoke({type: 'inc', by: 2});

    const log = await runtime.events('es.counter', 'a');
    expect(log.map(e => e.event)).toEqual([
      {type: 'Incremented', by: 3},
      {type: 'Incremented', by: 2},
    ]);
    expect(log.map(e => e.seq)).toEqual([0, 1]);
    expect(log.every(e => e.actor.id === 'a')).toBe(true);

    // The subscriber saw the same events as they committed.
    expect(seen.map(e => e.event)).toEqual(log.map(e => e.event));
    unsubscribe();
    await ref.invoke({type: 'inc', by: 1});
    expect(seen).toHaveLength(2); // no more after unsubscribe
  });

  it('does not append events when a turn rolls back', async () => {
    const runtime = new EventSourcedActorRuntime();
    const definition = counter();
    runtime.register(definition);
    const ref = runtime.ref(definition, 'b');

    await expect(ref.invoke({type: 'boom'})).rejects.toThrow('turn failed');
    expect(await runtime.events('es.counter', 'b')).toEqual([]);
    expect(await runtime.state(definition, 'b')).toEqual({count: 0});
  });

  it('does not re-append events on idempotent replay', async () => {
    const runtime = new EventSourcedActorRuntime();
    const definition = counter();
    runtime.register(definition);
    const ref = runtime.ref(definition, 'c');

    await ref.invoke({type: 'inc', by: 5}, {requestId: 'once'});
    await ref.invoke({type: 'inc', by: 5}, {requestId: 'once'}); // replay

    const log = await runtime.events('es.counter', 'c');
    expect(log).toHaveLength(1);
    expect(log[0]?.requestId).toBe('once');
    expect(await runtime.state(definition, 'c')).toEqual({count: 5});
  });

  it('keeps each identity log independent', async () => {
    const runtime = new EventSourcedActorRuntime();
    const definition = counter();
    runtime.register(definition);

    await runtime.ref(definition, 'x').invoke({type: 'inc', by: 1});
    expect(await runtime.events('es.counter', 'y')).toEqual([]);
  });
});
