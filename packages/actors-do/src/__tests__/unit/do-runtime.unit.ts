// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ACTOR_REGISTRY,
  ACTOR_TURN_TIMEOUT_EVENT,
  actor,
  actorCommand,
  defineActor,
  TurnTimeoutError,
  type Actor,
  type ActorTurn,
} from '@agentback/actors';
import {runActorRuntimeConformance} from '@agentback/actors/testing';
import {Application} from '@agentback/core';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {installDurableObjectActors} from '../../component.js';
import {createInProcessDoActorRuntime} from '../../in-process-host.js';

// The full behavioral contract every ActorRuntime adapter must satisfy —
// mutual exclusion, rollback, dedup, deadlines, the lot — against the
// in-process host, which delivers calls concurrently and clones across the
// stub boundary the way real Durable Object RPC does.
runActorRuntimeConformance('durable-objects (in-process host)', () =>
  createInProcessDoActorRuntime(),
);

const State = z.object({count: z.number()});
const Command = z.discriminatedUnion('type', [
  z.object({type: z.literal('inc'), by: z.number()}),
  z.object({type: z.literal('boom')}),
]);

function journal() {
  return defineActor('do.journal', {
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

// The journal read half (`ActorEventReader`). The adapter persists the log
// atomically with the commit but has no `subscribe` push channel, so it
// cannot enroll in `runActorEventStoreConformance` — these pin the same
// append/read invariants that suite covers, minus delivery.
describe('durable-objects journal (read half)', () => {
  it('appends a turn events to the identity log atomically with the commit', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = journal();
    runtime.register(definition);
    const ref = runtime.ref(definition, 'a');

    await ref.invoke({type: 'inc', by: 3}, {requestId: 'r1'});
    await ref.invoke({type: 'inc', by: 2}, {requestId: 'r2'});

    const log = await runtime.events('do.journal', 'a');
    expect(log.map(entry => entry.event)).toEqual([
      {type: 'Incremented', by: 3},
      {type: 'Incremented', by: 2},
    ]);
    expect(log.map(entry => entry.seq)).toEqual([0, 1]);
    expect(log.map(entry => entry.requestId)).toEqual(['r1', 'r2']);
    expect(log.every(entry => entry.seatKeyId === '')).toBe(true);
  });

  it('appends nothing when a turn rolls back', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = journal();
    runtime.register(definition);
    const ref = runtime.ref(definition, 'b');

    await ref.invoke({type: 'inc', by: 1});
    await expect(ref.invoke({type: 'boom'})).rejects.toThrow('turn failed');

    expect(await runtime.state(definition, 'b')).toEqual({count: 1});
    expect(await runtime.events('do.journal', 'b')).toHaveLength(1);
  });

  it('does not re-append events on an idempotent replay', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = journal();
    runtime.register(definition);
    const ref = runtime.ref(definition, 'c');

    await ref.invoke({type: 'inc', by: 5}, {requestId: 'once'});
    await ref.invoke({type: 'inc', by: 5}, {requestId: 'once'});

    const log = await runtime.events('do.journal', 'c');
    expect(log).toHaveLength(1);
    expect(await runtime.state(definition, 'c')).toEqual({count: 5});
  });

  it('reads an unknown identity log as empty', async () => {
    const runtime = createInProcessDoActorRuntime();
    runtime.register(journal());
    expect(await runtime.events('do.journal', 'never-addressed')).toEqual([]);
  });

  it('journals a timed-out turn as a failed turn, keeping the requestId retryable', async () => {
    const runtime = createInProcessDoActorRuntime();
    let hangs = true;
    const definition = defineActor('do.journal.deadline', {
      state: State,
      command: z.object({by: z.number()}),
      result: State,
      deadlineMs: 50,
      initialState: () => ({count: 0}),
      async receive(_ctx, state, command) {
        if (hangs) await new Promise<never>(() => {});
        state.count += command.by;
        return {
          state,
          result: state,
          events: [{type: 'Incremented', by: command.by}],
        };
      },
    });
    runtime.register(definition);
    const ref = runtime.ref(definition, 'timed-out');

    await expect(
      ref.invoke({by: 1}, {requestId: 'hangs'}),
    ).rejects.toBeInstanceOf(TurnTimeoutError);

    const afterTimeout = await runtime.events('do.journal.deadline', 'timed-out');
    expect(afterTimeout).toHaveLength(1);
    expect(afterTimeout[0]?.event.type).toBe(ACTOR_TURN_TIMEOUT_EVENT);
    expect(afterTimeout[0]?.event.deadlineMs).toBe(50);
    expect(afterTimeout[0]?.requestId).toBe('hangs');
    expect(afterTimeout[0]?.seq).toBe(0);
    expect(await runtime.state(definition, 'timed-out')).toEqual({count: 0});

    // The marker consumed a seq and touched neither state nor dedup: the same
    // requestId runs on retry and journals after the marker.
    hangs = false;
    await ref.invoke({by: 4}, {requestId: 'hangs'});
    const afterRetry = await runtime.events('do.journal.deadline', 'timed-out');
    expect(afterRetry.map(entry => entry.event.type)).toEqual([
      ACTOR_TURN_TIMEOUT_EVENT,
      'Incremented',
    ]);
    expect(afterRetry.map(entry => entry.seq)).toEqual([0, 1]);
    expect(await runtime.state(definition, 'timed-out')).toEqual({count: 4});
  });

  it('journals a nested timeout once, on the inner actor log only', async () => {
    const runtime = createInProcessDoActorRuntime();
    const inner = defineActor('do.deadline.inner', {
      state: State,
      command: z.object({}),
      result: State,
      deadlineMs: 50,
      initialState: () => ({count: 0}),
      async receive() {
        await new Promise<never>(() => {});
        throw new Error('unreachable');
      },
    });
    const outer = defineActor('do.deadline.outer', {
      state: State,
      command: z.object({}),
      result: State,
      deadlineMs: 5_000,
      initialState: () => ({count: 0}),
      async receive(_ctx, state) {
        await runtime.ref(inner, 'hangs').invoke({}, {requestId: 'nested'});
        return {state, result: state};
      },
    });
    runtime.register(inner);
    runtime.register(outer);

    const error = await runtime
      .ref(outer, 'caller')
      .invoke({}, {requestId: 'outer-call'})
      .catch((err: unknown) => err);

    // The revived error is a real TurnTimeoutError naming the inner turn.
    expect(error).toBeInstanceOf(TurnTimeoutError);
    const timeout = error as TurnTimeoutError;
    expect(timeout.actor).toEqual({type: 'do.deadline.inner', id: 'hangs'});
    expect(timeout.requestId).toBe('nested');

    const innerLog = await runtime.events('do.deadline.inner', 'hangs');
    expect(innerLog).toHaveLength(1);
    expect(innerLog[0]?.event.type).toBe(ACTOR_TURN_TIMEOUT_EVENT);
    expect(await runtime.events('do.deadline.outer', 'caller')).toEqual([]);
  });

  it('commits a nested JSON event payload exactly, on read-back', async () => {
    const runtime = createInProcessDoActorRuntime();
    const payload = {
      type: 'Snapshot',
      nested: {list: [1, 'two', true, null, {three: 3}], flag: false},
    };
    const definition = defineActor('do.journal.roundtrip', {
      state: State,
      command: z.object({}),
      result: State,
      initialState: () => ({count: 0}),
      receive(_ctx, state) {
        state.count += 1;
        return {state, result: state, events: [payload]};
      },
    });
    runtime.register(definition);

    await runtime.ref(definition, 'rt').invoke({}, {requestId: 'once'});

    const log = await runtime.events('do.journal.roundtrip', 'rt');
    expect(log).toHaveLength(1);
    expect(log[0]?.event).toEqual(payload);
  });
});

describe('durable-objects error revival across the stub boundary', () => {
  it('preserves name, message, and JSON-portable properties of a domain error', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = defineActor('do.domain-error', {
      state: State,
      command: z.object({}),
      result: State,
      initialState: () => ({count: 0}),
      receive() {
        const err = Object.assign(new Error('Provide a city.'), {
          code: 'invalid_input',
          status: 400,
          hint: 'city or coordinates',
        });
        err.name = 'AgentError';
        throw err;
      },
    });
    runtime.register(definition);

    const caught = (await runtime
      .ref(definition, 'x')
      .invoke({})
      .then(
        () => {
          throw new Error('expected the turn to throw');
        },
        (err: unknown) => err,
      )) as Error & Record<string, unknown>;

    expect(caught).toBeInstanceOf(Error);
    expect(caught.name).toBe('AgentError');
    expect(caught.message).toBe('Provide a city.');
    expect(caught.code).toBe('invalid_input');
    expect(caught.status).toBe(400);
    expect(caught.hint).toBe('city or coordinates');
  });
});

// The registry-driven path a production app uses: @actor service classes,
// installDurableObjectActors, invoke/ref/events through ACTOR_REGISTRY.
const CartState = z.object({total: z.number()});
type CartStateT = z.infer<typeof CartState>;
const AddItem = z.object({amount: z.number()});

@actor('do.cart', {state: CartState})
class CartActor implements Actor<CartStateT> {
  initialState(): CartStateT {
    return {total: 0};
  }

  @actorCommand('add', {input: AddItem, output: CartState})
  add(
    state: CartStateT,
    input: z.infer<typeof AddItem>,
  ): ActorTurn<CartStateT, CartStateT> {
    state.total += input.amount;
    return {state, result: state, events: [{type: 'Added', amount: input.amount}]};
  }
}

describe('durable-objects registry integration', () => {
  it('runs @actor commands through the registry, journal included', async () => {
    const app = new Application();
    installDurableObjectActors(app, {
      runtime: createInProcessDoActorRuntime(),
    });
    app.service(CartActor);
    await app.start();
    try {
      const registry = await app.get(ACTOR_REGISTRY);

      const invoked = await registry.invoke(
        'do.cart',
        'ada',
        {name: 'add', input: {amount: 3}},
        {requestId: 'r1'},
      );
      expect(invoked).toEqual({name: 'add', output: {total: 3}});

      const cart = registry.ref(CartActor, 'ada');
      expect(await cart.add({amount: 2}, {requestId: 'r2'})).toEqual({
        total: 5,
      });

      const log = await registry.events('do.cart', 'ada');
      expect(log.map(entry => entry.event.type)).toEqual(['Added', 'Added']);
      expect(log.map(entry => entry.seq)).toEqual([0, 1]);
    } finally {
      await app.stop();
    }
  });

  it('supports events() but names the missing delivery half on subscribe()', async () => {
    const app = new Application();
    installDurableObjectActors(app, {
      runtime: createInProcessDoActorRuntime(),
    });
    app.service(CartActor);
    await app.start();
    try {
      const registry = await app.get(ACTOR_REGISTRY);
      expect(() => registry.subscribe(() => undefined)).toThrow(
        /does not deliver/,
      );
    } finally {
      await app.stop();
    }
  });

  it('requires either a namespace or a runtime', () => {
    const app = new Application();
    expect(() => installDurableObjectActors(app, {})).toThrow(
      /namespace.*or a pre-wired.*runtime/,
    );
  });
});
