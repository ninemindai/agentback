// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Application,
  extensionFilter,
  inject,
  type Component,
} from '@agentback/core';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {InMemoryActorsComponent} from '../../component.js';
import {actor, actorCommand, actorQuery} from '../../decorators.js';
import {injectActor, type ActorAccessor} from '../../inject-actor.js';
import {ACTOR_EXTENSIONS, ACTOR_REGISTRY} from '../../keys.js';
import type {Actor, ActorCommandContext, ActorTurn} from '../../types.js';

const CounterState = z.object({value: z.number()});
const AddInput = z.object({amount: z.number()});
const CounterResult = z.object({value: z.number(), requestId: z.string()});
type Counter = z.infer<typeof CounterState>;

@actor('counter', {state: CounterState})
class CounterActor implements Actor<Counter> {
  constructor(@inject('services.step') private readonly step: number) {}

  initialState(): Counter {
    return {value: 0};
  }

  @actorCommand('add', {input: AddInput, output: CounterResult})
  add(
    state: Counter,
    input: z.infer<typeof AddInput>,
    ctx: ActorCommandContext,
  ): ActorTurn<Counter, z.infer<typeof CounterResult>> {
    state.value += input.amount * this.step;
    return {state, result: {value: state.value, requestId: ctx.requestId}};
  }

  @actorQuery('peek', {input: z.object({}), output: CounterState})
  peek(state: Counter): Counter {
    return {value: state.value}; // read-only
  }
}

class CounterComponent implements Component {
  services = [CounterActor];
}

describe('decorated actor registry', () => {
  it('tags @actor classes as extensions', () => {
    const app = new Application();
    const binding = app.service(CounterActor);
    expect(extensionFilter(ACTOR_EXTENSIONS)(binding)).toBe(true);
  });

  it('discovers, compiles, and invokes a DI-resolved actor service', async () => {
    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.bind('services.step').to(2);
    app.component(CounterComponent);
    await app.start();

    const registry = await app.get(ACTOR_REGISTRY);
    expect(registry.list()).toEqual(['counter']);
    const result = await registry.invoke(
      'counter',
      'customer-42',
      {name: 'add', input: {amount: 3}},
      {requestId: 'request-1'},
    );

    expect(result).toEqual({
      name: 'add',
      output: {value: 6, requestId: 'request-1'},
    });
    expect(await registry.state('counter', 'customer-42')).toEqual({value: 6});
    await app.stop();
  });

  it('returns a strongly-typed proxy from ref(ActorClass, id)', async () => {
    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.bind('services.step').to(2);
    app.component(CounterComponent);
    await app.start();
    const registry = await app.get(ACTOR_REGISTRY);

    // Typed: `add` accepts {amount} and resolves to {value, requestId}; the
    // method-name → command-name map and routing come from @actorCommand.
    const counter = registry.ref(CounterActor, 'customer-7');
    const out = await counter.add({amount: 3}, {requestId: 'req-9'});
    expect(out).toEqual({value: 6, requestId: 'req-9'});

    // Same identity is the same state; idempotent replay through the proxy.
    const replay = await counter.add({amount: 3}, {requestId: 'req-9'});
    expect(replay).toEqual(out);
    expect(await registry.state('counter', 'customer-7')).toEqual({value: 6});

    // Compile-time proof the proxy is narrowed, not `any` (never executed).
    const _typeChecks = async (px: typeof counter) => {
      const r: {value: number; requestId: string} = await px.add({amount: 1});
      void r;
      // @ts-expect-error — input must be {amount: number}
      await px.add({nope: 1});
      // @ts-expect-error — initialState is not a command on the proxy
      px.initialState;
    };
    void _typeChecks;
    await app.stop();
  });

  it('runs read-only @actorQuery lease-free, via envelope and proxy', async () => {
    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.bind('services.step').to(2);
    app.component(CounterComponent);
    await app.start();
    const registry = await app.get(ACTOR_REGISTRY);

    await registry.invoke(
      'counter',
      'q1',
      {name: 'add', input: {amount: 5}},
      {requestId: 'r1'},
    );

    // Envelope query and typed-proxy query agree, and neither takes a turn.
    const counter = registry.ref(CounterActor, 'q1');
    const out = await counter.peek({});
    expect(out).toEqual({value: 10});
    expect(
      await registry.query('counter', 'q1', {name: 'peek', input: {}}),
    ).toEqual({value: 10});

    // A query on a never-touched id returns the initial state (and stores nothing).
    expect(
      await registry.query('counter', 'fresh', {name: 'peek', input: {}}),
    ).toEqual({value: 0});

    // Compile-time: the query is on the same proxy, typed (never executed).
    const _queryTypes = async (px: typeof counter) => {
      const v: {value: number} = await px.peek({});
      void v;
      // @ts-expect-error — 'nope' is not a command or query on the proxy
      px.nope;
    };
    void _queryTypes;
    await app.stop();
  });

  it('rejects ref() for a class that is not an @actor', async () => {
    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.bind('services.step').to(1);
    app.component(CounterComponent);
    await app.start();
    const registry = await app.get(ACTOR_REGISTRY);

    class NotAnActor {}
    expect(() => registry.ref(NotAnActor, 'x')).toThrow('is not an @actor');
    await app.stop();
  });

  it('@injectActor injects a typed actor accessor (no client class)', async () => {
    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.bind('services.step').to(2);
    app.component(CounterComponent);

    class Caller {
      constructor(
        @injectActor(CounterActor)
        readonly counters: ActorAccessor<CounterActor>,
      ) {}
    }
    app.bind('callers.Caller').toClass(Caller);
    await app.start();

    const caller = await app.get<Caller>('callers.Caller');
    const out = await caller.counters('c1').add({amount: 4}, {requestId: 'r1'});
    expect(out).toEqual({value: 8, requestId: 'r1'});
    expect(await caller.counters('c1').peek({})).toEqual({value: 8});
    await app.stop();
  });

  it('validates decorated command input before calling the method', async () => {
    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.bind('services.step').to(1);
    app.component(CounterComponent);
    await app.start();
    const registry = await app.get(ACTOR_REGISTRY);

    await expect(
      registry.invoke('counter', 'one', {
        name: 'add',
        input: {amount: 'invalid'},
      }),
    ).rejects.toThrow();
    expect(await registry.state('counter', 'one')).toEqual({value: 0});
    await app.stop();
  });

  it('fails startup on duplicate actor type names', async () => {
    @actor('duplicate', {state: CounterState})
    class First implements Actor<Counter> {
      initialState() {
        return {value: 0};
      }
      @actorCommand('read', {input: z.object({}), output: z.number()})
      read(state: Counter) {
        return {state, result: state.value};
      }
    }
    @actor('duplicate', {state: CounterState})
    class Second extends First {}

    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.service(First);
    app.service(Second);
    await expect(app.start()).rejects.toThrow(
      "Duplicate actor type 'duplicate'",
    );
  });

  it('fails startup on duplicate command names', async () => {
    @actor('bad-commands', {state: CounterState})
    class BadCommands implements Actor<Counter> {
      initialState() {
        return {value: 0};
      }
      @actorCommand('same', {input: z.object({}), output: z.number()})
      first(state: Counter) {
        return {state, result: state.value};
      }
      @actorCommand('same', {input: z.object({}), output: z.number()})
      second(state: Counter) {
        return {state, result: state.value};
      }
    }

    class BadComponent implements Component {
      services = [BadCommands];
    }
    const app = new Application();
    app.component(InMemoryActorsComponent);
    app.component(BadComponent);
    await expect(app.start()).rejects.toThrow("duplicate command 'same'");
  });
});
