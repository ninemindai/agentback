// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';
import {
  BindingScope,
  Context,
  createBindingFromClass,
  inject,
  injectable,
} from '@agentback/context';

import {promisify} from 'util';
import {
  asLifeCycleObserver,
  CoreBindings,
  CoreTags,
  LifeCycleObserver,
  LifeCycleObserverRegistry,
} from '../../index.js';
import {DEFAULT_ORDERED_GROUPS} from '../../lifecycle-registry.js';
const sleep = promisify(setTimeout);

describe('LifeCycleRegistry', () => {
  let context: Context;
  let registry: TestObserverRegistry;
  const events: string[] = [];

  beforeEach(() => events.splice(0, events.length));
  beforeEach(givenContext);
  beforeEach(givenLifeCycleRegistry);

  it('starts all registered observers', async () => {
    givenObserver('1');
    givenObserver('2');
    await registry.start();
    expect(events).toEqual(['1-start', '2-start']);
  });

  it('skips notification of disabled groups', async () => {
    givenObserver('1', 'a');
    givenObserver('2', 'b');
    registry.setDisabledGroups(['a']);
    await registry.start();
    expect(events).toEqual(['2-start']);
  });

  it('starts/stops all registered observers with param injections', async () => {
    givenObserverWithParamInjection('1');
    givenObserverWithParamInjection('2');
    context.bind('prefix').to('***');
    await registry.start();
    expect(events).toEqual(['***:1-start', '***:2-start']);
    context.bind('prefix').to('###');
    events.splice(0, events.length);
    await registry.stop();
    expect(events).toEqual(['###:2-stop', '###:1-stop']);
  });

  it('reports error for observers with param injections if key is not bound', async () => {
    givenObserverWithParamInjection('1');
    await expect(registry.start()).rejects.toThrow(
      /The key 'prefix' is not bound to any value in context app/,
    );
  });

  it('starts all registered async observers', async () => {
    givenAsyncObserver('1', 'g1');
    givenAsyncObserver('2', 'g2');
    registry.setOrderedGroups(['g1', 'g2']);
    await registry.start();
    expect(events).toEqual(['1-start', '2-start']);
  });

  it('stops all registered observers in reverse order', async () => {
    givenObserver('1');
    givenObserver('2');
    await registry.stop();
    expect(events).toEqual(['2-stop', '1-stop']);
  });

  it('stops all registered async observers in reverse order', async () => {
    givenAsyncObserver('1', 'g1');
    givenAsyncObserver('2', 'g2');
    registry.setOrderedGroups(['g1', 'g2']);
    await registry.stop();
    expect(events).toEqual(['2-stop', '1-stop']);
  });

  it('starts all registered observers by group', async () => {
    givenObserver('1', 'g1');
    givenObserver('2', 'g2');
    givenObserver('3', 'g1');
    registry.setOrderedGroups(['g1', 'g2']);
    const groups = registry.getOrderedGroups();
    expect(groups).toEqual(['g1', 'g2']);
    await registry.start();
    expect(events).toEqual(['1-start', '3-start', '2-start']);
  });

  it('stops all registered observers in reverse order by group', async () => {
    givenObserver('1', 'g1');
    givenObserver('2', 'g2');
    givenObserver('3', 'g1');
    registry.setOrderedGroups(['g1', 'g2']);
    await registry.stop();
    expect(events).toEqual(['2-stop', '3-stop', '1-stop']);
  });

  it('starts observers by alphabetical groups if no order is configured', async () => {
    givenObserver('1', 'g1');
    givenObserver('2', 'g2');
    givenObserver('3', 'g1');
    givenObserver('4', 'g0');
    const groups = registry.getOrderedGroups();
    expect(groups).toEqual(['g0', 'g1', 'g2']);
    await registry.start();
    expect(events).toEqual(['4-start', '1-start', '3-start', '2-start']);
  });

  it('runs all registered observers within the same group in parallel', async () => {
    // 1st group: g1-1 takes 20 ms more than g1-2 to finish
    givenAsyncObserver('g1-1', 'g1', 20);
    givenAsyncObserver('g1-2', 'g1', 0);

    // 2nd group: g2-1 takes 20 ms more than g2-2 to finish
    givenAsyncObserver('g2-1', 'g2', 20);
    givenAsyncObserver('g2-2', 'g2', 0);

    registry.setOrderedGroups(['g1', 'g2']);
    registry.setParallel(true);
    await registry.start();
    expect(events.length).toBe(4);

    // 1st group: g1-1, g1-2
    const group1 = events.slice(0, 2);
    expect(group1.sort()).toEqual(['g1-1-start', 'g1-2-start']);

    // 2nd group: g2-1, g2-2
    const group2 = events.slice(2, 4);
    expect(group2.sort()).toEqual(['g2-1-start', 'g2-2-start']);
  });

  it('runs all registered observers within the same group in serial', async () => {
    // 1st group: g1-1 takes 20 ms more than g1-2 to finish
    givenAsyncObserver('g1-1', 'g1', 20);
    givenAsyncObserver('g1-2', 'g1', 0);

    // 2nd group: g2-1 takes 20 ms more than g2-2 to finish
    givenAsyncObserver('g2-1', 'g2', 20);
    givenAsyncObserver('g2-2', 'g2', 0);

    registry.setOrderedGroups(['g1', 'g2']);
    registry.setParallel(false);
    await registry.start();
    expect(events.length).toBe(4);
    expect(events).toEqual([
      'g1-1-start',
      'g1-2-start',
      'g2-1-start',
      'g2-2-start',
    ]);
  });

  it('startObservers notifies only the selected observers', async () => {
    givenObserverWithInit('1');
    givenObserverWithInit('2');
    await registry.startObservers(new Set(['observers.observer-2']));
    expect(events).toEqual(['2-init', '2-start']);
  });

  it('startObservers runs init across ALL groups before any start', async () => {
    // The property that forces two `notifyGroups` passes: a single
    // `notifyGroups(['init', 'start'])` iterates events INSIDE each group and
    // would yield 1-init, 1-start, 2-init, 2-start — so an observer in g2
    // whose init must precede g1's start would be broken.
    givenObserverWithInit('1', 'g1');
    givenObserverWithInit('2', 'g2');
    registry.setOrderedGroups(['g1', 'g2']);
    await registry.startObservers(
      new Set(['observers.observer-1', 'observers.observer-2']),
    );
    expect(events).toEqual(['1-init', '2-init', '1-start', '2-start']);
  });

  it('startObservers honors group order and disabled groups', async () => {
    givenObserverWithInit('1', 'g1');
    givenObserverWithInit('2', 'g2');
    registry.setOrderedGroups(['g2', 'g1']);
    registry.setDisabledGroups(['g2']);
    await registry.startObservers(
      new Set(['observers.observer-1', 'observers.observer-2']),
    );
    expect(events).toEqual(['1-init', '1-start']);
  });

  it('startObservers is a no-op for an empty or non-matching key set', async () => {
    givenObserverWithInit('1');
    await registry.startObservers(new Set());
    await registry.startObservers(new Set(['observers.observer-absent']));
    expect(events).toEqual([]);
  });

  it('startObservers leaves the registry usable for a later full stop', async () => {
    // Guards the in-place `group.bindings.reverse()` hazard: a partial start
    // must not mutate the registry's own group objects.
    givenObserverWithInit('1', 'g1');
    givenObserverWithInit('2', 'g2');
    registry.setOrderedGroups(['g1', 'g2']);
    await registry.startObservers(new Set(['observers.observer-1']));
    events.splice(0, events.length);
    await registry.stop();
    expect(events).toEqual(['2-stop', '1-stop']);
  });

  it('startObservers stops what it started when a SERIAL sibling throws', async () => {
    givenObserverWithInit('1');
    givenThrowingStartObserver('boom');
    givenObserverWithInit('2');
    const keys = new Set([
      'observers.observer-1',
      'observers.observer-boom',
      'observers.observer-2',
    ]);

    await expect(registry.startObservers(keys)).rejects.toThrow(
      'start exploded',
    );

    // The serial loop starts 1, then boom throws — 2 never starts. 1 must not
    // be left running: its bindings are about to be unbound by the caller's
    // rollback, after which the full stop() pass can no longer reach it.
    expect(events).toContain('1-start');
    expect(events).not.toContain('2-start');
    expect(events).toContain('1-stop');
  });

  it('startObservers stops what it started when a PARALLEL sibling throws', async () => {
    // The harder half: Promise.all rejects on the FIRST failure while its
    // siblings keep running, so a naive unwind races observers that are still
    // starting and misses one it then has to stop. `settle` is what makes the
    // started-set complete before the error surfaces.
    givenObserverWithInit('1');
    givenThrowingStartObserver('boom');
    givenObserverWithInit('2');
    registry.setParallel(true);
    const keys = new Set([
      'observers.observer-1',
      'observers.observer-boom',
      'observers.observer-2',
    ]);

    await expect(registry.startObservers(keys)).rejects.toThrow(
      'start exploded',
    );

    // Both siblings started concurrently and BOTH must be stopped.
    expect(events).toContain('1-start');
    expect(events).toContain('2-start');
    expect(events).toContain('1-stop');
    expect(events).toContain('2-stop');
  });

  it('startObservers waits for an in-flight PARALLEL sibling before unwinding', async () => {
    // This is what `settle` buys, and it needs a SLOW sibling to show it: with
    // plain Promise.all the rejection surfaces while `slow` is still starting,
    // so the unwind runs against an incomplete started-set and leaks the very
    // observer that finishes a moment later. With allSettled, `slow` is
    // recorded before the error propagates and is therefore stopped.
    givenSlowStartObserver('slow', 20);
    givenThrowingStartObserver('boom');
    registry.setParallel(true);

    await expect(
      registry.startObservers(
        new Set(['observers.observer-slow', 'observers.observer-boom']),
      ),
    ).rejects.toThrow('start exploded');

    expect(events).toContain('slow-start');
    expect(events).toContain('slow-stop');
  });

  it('startObservers surfaces the start failure even if the unwind also fails', async () => {
    // A failed unwind is additional damage; it must not replace the diagnosis
    // the caller actually needs.
    givenObserverWithFailingStop('bad');
    givenThrowingStartObserver('boom');

    const err = (await registry
      .startObservers(
        new Set(['observers.observer-bad', 'observers.observer-boom']),
      )
      .catch((e: unknown) => e)) as AggregateError;

    expect(err).toBeInstanceOf(AggregateError);
    expect(
      err.errors.some(e => (e as Error).message.includes('start exploded')),
    ).toBe(true);
  });

  function givenThrowingStartObserver(name: string, group = '') {
    @injectable({tags: {[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: group}})
    class MyObserver implements LifeCycleObserver {
      init() {
        events.push(`${name}-init`);
      }
      start(): void {
        throw new Error('start exploded');
      }
      stop() {
        events.push(`${name}-stop`);
      }
    }
    context.add(
      createBindingFromClass(MyObserver, {
        key: `observers.observer-${name}`,
      }).apply(asLifeCycleObserver),
    );
    return MyObserver;
  }

  function givenSlowStartObserver(name: string, delayInMs: number, group = '') {
    @injectable({tags: {[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: group}})
    class MyObserver implements LifeCycleObserver {
      async start() {
        await sleep(delayInMs);
        events.push(`${name}-start`);
      }
      async stop() {
        events.push(`${name}-stop`);
      }
    }
    context.add(
      createBindingFromClass(MyObserver, {
        key: `observers.observer-${name}`,
      }).apply(asLifeCycleObserver),
    );
    return MyObserver;
  }

  function givenObserverWithFailingStop(name: string, group = '') {
    @injectable({tags: {[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: group}})
    class MyObserver implements LifeCycleObserver {
      start() {
        events.push(`${name}-start`);
      }
      stop(): void {
        throw new Error('stop exploded');
      }
    }
    context.add(
      createBindingFromClass(MyObserver, {
        key: `observers.observer-${name}`,
      }).apply(asLifeCycleObserver),
    );
    return MyObserver;
  }

  function givenContext() {
    context = new Context('app');
  }

  /**
   * Create a subclass to expose some protected properties/methods for testing
   */
  class TestObserverRegistry extends LifeCycleObserverRegistry {
    getOrderedGroups(): string[] {
      return super.getObserverGroupsByOrder().map(g => g.group);
    }

    setParallel(parallel?: boolean) {
      this.options.parallel = parallel;
    }

    setDisabledGroups(groups?: string[]) {
      this.options.disabledGroups = groups;
    }
  }

  async function givenLifeCycleRegistry() {
    context.bind(CoreBindings.LIFE_CYCLE_OBSERVER_OPTIONS).to({
      orderedGroups: DEFAULT_ORDERED_GROUPS,
      parallel: false,
    });
    context
      .bind(CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY)
      .toClass(TestObserverRegistry)
      .inScope(BindingScope.SINGLETON);
    registry = (await context.get(
      CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY,
    )) as TestObserverRegistry;
  }

  function givenObserver(name: string, group = '') {
    @injectable({tags: {[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: group}})
    class MyObserver implements LifeCycleObserver {
      start() {
        events.push(`${name}-start`);
      }
      stop() {
        events.push(`${name}-stop`);
      }
    }
    const binding = createBindingFromClass(MyObserver, {
      key: `observers.observer-${name}`,
    }).apply(asLifeCycleObserver);
    context.add(binding);

    return MyObserver;
  }

  /** Like {@link givenObserver}, plus an `init` — for the partial-start path. */
  function givenObserverWithInit(name: string, group = '') {
    @injectable({tags: {[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: group}})
    class MyObserver implements LifeCycleObserver {
      init() {
        events.push(`${name}-init`);
      }
      start() {
        events.push(`${name}-start`);
      }
      stop() {
        events.push(`${name}-stop`);
      }
    }
    const binding = createBindingFromClass(MyObserver, {
      key: `observers.observer-${name}`,
    }).apply(asLifeCycleObserver);
    context.add(binding);

    return MyObserver;
  }

  function givenObserverWithParamInjection(name: string, group = '') {
    @injectable({tags: {[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: group}})
    class MyObserver implements LifeCycleObserver {
      start(@inject('prefix') prefix: string) {
        events.push(`${prefix}:${name}-start`);
      }
      stop(@inject('prefix') prefix: string) {
        events.push(`${prefix}:${name}-stop`);
      }
    }
    const binding = createBindingFromClass(MyObserver, {
      key: `observers.observer-${name}`,
    }).apply(asLifeCycleObserver);
    context.add(binding);

    return MyObserver;
  }

  function givenAsyncObserver(name: string, group = '', delayInMs = 0) {
    @injectable({tags: {[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: group}})
    class MyAsyncObserver implements LifeCycleObserver {
      async start() {
        await sleep(delayInMs);
        events.push(`${name}-start`);
      }
      async stop() {
        await sleep(delayInMs);
        events.push(`${name}-stop`);
      }
    }
    const binding = createBindingFromClass(MyAsyncObserver, {
      key: `observers.observer-${name}`,
    }).apply(asLifeCycleObserver);
    context.add(binding);

    return MyAsyncObserver;
  }
});
