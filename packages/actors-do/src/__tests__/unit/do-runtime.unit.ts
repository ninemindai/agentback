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

    const afterTimeout = await runtime.events(
      'do.journal.deadline',
      'timed-out',
    );
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
    return {
      state,
      result: state,
      events: [{type: 'Added', amount: input.amount}],
    };
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

// Review-driven cases: the storage layout (per-key dedup + FIFO eviction),
// factory validation, definition loading, and the remaining envelope paths.
describe('durable-objects storage layout and factory edges', () => {
  it('evicts the oldest dedup entry FIFO; a replay of an evicted requestId re-runs', async () => {
    const runtime = createInProcessDoActorRuntime({dedupLimit: 2});
    let turns = 0;
    const definition = defineActor('do.evict', {
      state: State,
      command: z.object({by: z.number()}),
      result: State,
      initialState: () => ({count: 0}),
      receive(_ctx, state, command) {
        turns++;
        state.count += command.by;
        return {state, result: state};
      },
    });
    runtime.register(definition);
    const ref = runtime.ref(definition, 'e');

    await ref.invoke({by: 1}, {requestId: 'r1'});
    await ref.invoke({by: 2}, {requestId: 'r2'});
    await ref.invoke({by: 4}, {requestId: 'r3'}); // evicts r1
    expect(turns).toBe(3);

    // r2 and r3 still replay without re-running.
    expect(await ref.invoke({by: 2}, {requestId: 'r2'})).toEqual({count: 3});
    expect(await ref.invoke({by: 4}, {requestId: 'r3'})).toEqual({count: 7});
    expect(turns).toBe(3);

    // r1 was evicted: the same requestId re-runs the command.
    expect(await ref.invoke({by: 1}, {requestId: 'r1'})).toEqual({count: 8});
    expect(turns).toBe(4);
  });

  it('keeps journal read order across double-digit seqs', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = journal();
    runtime.register(definition);
    const ref = runtime.ref(definition, 'twelve');

    for (let i = 0; i < 12; i++) {
      await ref.invoke({type: 'inc', by: i}, {requestId: `r${i}`});
    }

    const log = await runtime.events('do.journal', 'twelve');
    expect(log.map(entry => entry.seq)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(log.map(entry => entry.event.by)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('rejects a turn emitting more events than one atomic commit can carry', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = defineActor('do.too-many-events', {
      state: State,
      command: z.object({}),
      result: State,
      initialState: () => ({count: 0}),
      receive(_ctx, state) {
        state.count += 1;
        return {
          state,
          result: state,
          events: Array.from({length: 101}, (_, i) => ({type: 'E', i})),
        };
      },
    });
    runtime.register(definition);

    await expect(runtime.ref(definition, 'x').invoke({})).rejects.toThrow(
      /at most 100 per turn/,
    );
    // The turn rolled back like any other failed turn.
    expect(await runtime.state(definition, 'x')).toEqual({count: 0});
    expect(await runtime.events('do.too-many-events', 'x')).toEqual([]);
  });

  it('validates dedupLimit at factory time', async () => {
    const {createActorDurableObject} =
      await import('../../actor-durable-object.js');
    expect(() => createActorDurableObject(() => [], {dedupLimit: 0})).toThrow(
      /positive integer/,
    );
    expect(() => createActorDurableObject(() => [], {dedupLimit: 1.5})).toThrow(
      /positive integer/,
    );
  });

  it('rejects duplicate definition names from the loader, per turn', async () => {
    const {createActorDurableObject} =
      await import('../../actor-durable-object.js');
    const {InProcessDurableObjectHost} =
      await import('../../in-process-host.js');
    const {DurableObjectActorRuntime} =
      await import('../../do-actor-runtime.js');
    const a = journal();
    const b = journal(); // distinct object, same 'do.journal' name
    const objectClass = createActorDurableObject(() => [a, b]);
    const runtime = new DurableObjectActorRuntime(
      new InProcessDurableObjectHost(objectClass),
    );
    runtime.register(a);

    await expect(
      runtime.ref(a, 'dup').invoke({type: 'inc', by: 1}),
    ).rejects.toThrow(/defined twice/);
  });

  it('retries definition loading after a transient loader failure', async () => {
    const {createActorDurableObject} =
      await import('../../actor-durable-object.js');
    const {InProcessDurableObjectHost} =
      await import('../../in-process-host.js');
    const {DurableObjectActorRuntime} =
      await import('../../do-actor-runtime.js');
    const definition = journal();
    let calls = 0;
    const objectClass = createActorDurableObject(() => {
      if (++calls === 1) throw new Error('config store unavailable');
      return [definition];
    });
    const runtime = new DurableObjectActorRuntime(
      new InProcessDurableObjectHost(objectClass),
    );
    runtime.register(definition);
    const ref = runtime.ref(definition, 'transient');

    await expect(ref.invoke({type: 'inc', by: 1})).rejects.toThrow(
      'config store unavailable',
    );
    // The failed load was not memoized: the next turn loads and runs.
    expect(await ref.invoke({type: 'inc', by: 1})).toEqual({count: 1});
    expect(calls).toBe(2);
  });

  it('rejects registering two different definitions under one type', () => {
    const runtime = createInProcessDoActorRuntime();
    runtime.register(journal());
    expect(() => runtime.register(journal())).toThrow(/already registered/);
  });

  it('revives an initialState failure from a lease-free state read', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = defineActor('do.bad-init', {
      state: State,
      command: z.object({}),
      result: State,
      initialState: () => {
        throw new Error('seed data missing');
      },
      receive(_ctx, state) {
        return {state, result: state};
      },
    });
    runtime.register(definition);

    await expect(runtime.state(definition, 'cold')).rejects.toThrow(
      'seed data missing',
    );
  });

  it('revives a non-Error throw as an Error carrying its string form', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = defineActor('do.string-throw', {
      state: State,
      command: z.object({}),
      result: State,
      initialState: () => ({count: 0}),
      receive() {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain string failure';
      },
    });
    runtime.register(definition);

    await expect(runtime.ref(definition, 's').invoke({})).rejects.toThrow(
      'plain string failure',
    );
  });

  it('installs from a raw namespace binding', async () => {
    const {createActorDurableObject} =
      await import('../../actor-durable-object.js');
    const {InProcessDurableObjectHost} =
      await import('../../in-process-host.js');
    const definition = journal();
    const namespace = new InProcessDurableObjectHost(
      createActorDurableObject(() => [definition]),
    );

    const app = new Application();
    const runtime = installDurableObjectActors(app, {namespace});
    runtime.register(definition);
    await app.start();
    try {
      // The helper constructed the runtime from the namespace and bound it.
      const {ACTOR_RUNTIME} = await import('@agentback/actors');
      expect(await app.get(ACTOR_RUNTIME)).toBe(runtime);

      await runtime.ref(definition, 'ns').invoke({type: 'inc', by: 2});
      expect(await runtime.state(definition, 'ns')).toEqual({count: 2});
      expect(
        (await runtime.events('do.journal', 'ns')).map(e => e.event),
      ).toEqual([{type: 'Incremented', by: 2}]);
    } finally {
      await app.stop();
    }
  });
});

// Outside-voice (Codex) findings, each pinned by a test: best-effort
// eviction, marker-failure masking, requestId bounds, mis-routed identity,
// and the baseClass seam Cloudflare RPC requires.
describe('durable-objects hardening (outside-voice findings)', () => {
  async function engine() {
    const {createActorDurableObject} =
      await import('../../actor-durable-object.js');
    return {createActorDurableObject};
  }

  it('never fails a committed turn because dedup eviction failed', async () => {
    const {createActorDurableObject} = await engine();
    const entries = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string): Promise<T | undefined> {
        return entries.has(key)
          ? (structuredClone(entries.get(key)) as T)
          : undefined;
      },
      async put(batch: Record<string, unknown>): Promise<void> {
        for (const [k, v] of Object.entries(batch)) {
          entries.set(k, structuredClone(v));
        }
      },
      async delete(): Promise<never> {
        throw new Error('storage delete outage');
      },
      async list<T>({prefix}: {prefix: string}): Promise<Map<string, T>> {
        return new Map(
          [...entries].filter(([k]) => k.startsWith(prefix)) as Array<
            [string, T]
          >,
        );
      },
    };
    const definition = defineActor('do.evict-outage', {
      state: State,
      command: z.object({by: z.number()}),
      result: State,
      initialState: () => ({count: 0}),
      receive(_ctx, state, command) {
        state.count += command.by;
        return {state, result: state};
      },
    });
    const ObjectClass = createActorDurableObject(() => [definition], {
      dedupLimit: 1,
    });
    const object = new ObjectClass({storage});
    const actor = {type: 'do.evict-outage', id: 'x'};

    const first = await object.turn({actor, requestId: 'r1', command: {by: 1}});
    expect(first).toEqual({ok: true, result: {count: 1}});
    // r2 evicts r1; the delete throws; the committed turn still succeeds.
    const second = await object.turn({
      actor,
      requestId: 'r2',
      command: {by: 2},
    });
    expect(second).toEqual({ok: true, result: {count: 3}});
  });

  it('keeps the TurnTimeoutError when the marker write fails', async () => {
    const {createActorDurableObject} = await engine();
    const entries = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string): Promise<T | undefined> {
        return entries.has(key)
          ? (structuredClone(entries.get(key)) as T)
          : undefined;
      },
      async put(batch: Record<string, unknown>): Promise<void> {
        // Fail exactly the timeout-marker write (the only put whose values
        // carry the reserved marker type).
        for (const value of Object.values(batch)) {
          const event = (value as {event?: {type?: string}}).event;
          if (event?.type === ACTOR_TURN_TIMEOUT_EVENT) {
            throw new Error('storage down during marker write');
          }
        }
        for (const [k, v] of Object.entries(batch)) {
          entries.set(k, structuredClone(v));
        }
      },
      async delete(): Promise<number> {
        return 0;
      },
      async list<T>({prefix}: {prefix: string}): Promise<Map<string, T>> {
        return new Map(
          [...entries].filter(([k]) => k.startsWith(prefix)) as Array<
            [string, T]
          >,
        );
      },
    };
    const definition = defineActor('do.marker-outage', {
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
    const ObjectClass = createActorDurableObject(() => [definition]);
    const object = new ObjectClass({storage});

    const outcome = await object.turn({
      actor: {type: 'do.marker-outage', id: 'x'},
      requestId: 'hangs',
      command: {},
    });
    // The caller still receives the typed timeout, not the storage error.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('timeout');
    }
  });

  it('rejects a requestId longer than 256 characters before it becomes a storage key', async () => {
    const runtime = createInProcessDoActorRuntime();
    const definition = journal();
    runtime.register(definition);

    await expect(
      runtime
        .ref(definition, 'long')
        .invoke({type: 'inc', by: 1}, {requestId: 'r'.repeat(257)}),
    ).rejects.toThrow(/at most 256 characters/);
    // Boundary value passes.
    await runtime
      .ref(definition, 'long')
      .invoke({type: 'inc', by: 1}, {requestId: 'r'.repeat(256)});
  });

  it('refuses a mis-routed request addressed to another identity', async () => {
    const {createActorDurableObject} = await engine();
    const {InProcessDurableObjectHost} =
      await import('../../in-process-host.js');
    const definition = journal();
    const host = new InProcessDurableObjectHost(
      createActorDurableObject(() => [definition]),
    );
    const stub = host.get(host.idFromName('one-object'));

    const first = await stub.turn({
      actor: {type: 'do.journal', id: 'a'},
      requestId: 'r1',
      command: {type: 'inc', by: 1},
    });
    expect(first.ok).toBe(true);

    // Same object, different claimed identity: refused, nothing written.
    const misrouted = await stub.turn({
      actor: {type: 'do.journal', id: 'b'},
      requestId: 'r2',
      command: {type: 'inc', by: 5},
    });
    expect(misrouted.ok).toBe(false);
    if (!misrouted.ok && misrouted.error.kind === 'error') {
      expect(misrouted.error.message).toMatch(/mis-routed/);
    }
    const state = await stub.readState({type: 'do.journal', id: 'a'});
    expect(state).toEqual({ok: true, state: {count: 1}});
  });

  it('extends the provided baseClass and forwards (state, env) to it', async () => {
    const {createActorDurableObject} = await engine();
    const seen: unknown[] = [];
    class FakeDurableObject {
      constructor(...args: unknown[]) {
        seen.push(args);
      }
    }
    const definition = journal();
    const ObjectClass = createActorDurableObject(() => [definition], {
      baseClass: FakeDurableObject,
    });
    const entries = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string): Promise<T | undefined> {
        return entries.has(key)
          ? (structuredClone(entries.get(key)) as T)
          : undefined;
      },
      async put(batch: Record<string, unknown>): Promise<void> {
        for (const [k, v] of Object.entries(batch)) {
          entries.set(k, structuredClone(v));
        }
      },
      async delete(): Promise<number> {
        return 0;
      },
      async list<T>(_o: {prefix: string}): Promise<Map<string, T>> {
        return new Map();
      },
    };
    const env = {BINDING: 'x'};
    const object = new ObjectClass({storage}, env);

    expect(object).toBeInstanceOf(FakeDurableObject);
    expect(seen).toEqual([[{storage}, env]]);
    const outcome = await object.turn({
      actor: {type: 'do.journal', id: 'base'},
      requestId: 'r1',
      command: {type: 'inc', by: 1},
    });
    expect(outcome).toMatchObject({ok: true, result: {count: 1}});
  });
});
