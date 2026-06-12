// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';
import {
  Binding,
  BindingScope,
  Context,
  injectable,
} from '@agentback/context';

import {
  asLifeCycleObserver,
  CoreTags,
  isLifeCycleObserver,
  isLifeCycleObserverClass,
  LifeCycleObserver,
  lifeCycleObserver,
  lifeCycleObserverFilter,
} from '../../index.js';

describe('LifeCycle', () => {
  describe('isLifeCycleObserver', () => {
    it('returns true for object with start method', () => {
      const obj = {
        start() {},
      };
      expect(isLifeCycleObserver(obj)).toBe(true);
    });

    it('returns true for object with stop method', () => {
      const obj = {
        stop() {},
      };
      expect(isLifeCycleObserver(obj)).toBe(true);
    });

    it('returns true for object with init method', () => {
      const obj = {
        init() {},
      };
      expect(isLifeCycleObserver(obj)).toBe(true);
    });

    it('returns true for object with all lifecycle methods', () => {
      const obj = {
        init() {},
        start() {},
        stop() {},
      };
      expect(isLifeCycleObserver(obj)).toBe(true);
    });

    it('returns true for object with async lifecycle methods', () => {
      const obj = {
        async init() {},
        async start() {},
        async stop() {},
      };
      expect(isLifeCycleObserver(obj)).toBe(true);
    });

    it('returns true for object with lifecycle methods returning promises', () => {
      const obj = {
        init() {
          return Promise.resolve();
        },
        start() {
          return Promise.resolve();
        },
        stop() {
          return Promise.resolve();
        },
      };
      expect(isLifeCycleObserver(obj)).toBe(true);
    });

    it('returns true for object with lifecycle methods with parameters', () => {
      const obj = {
        init(...args: unknown[]) {},
        start(...args: unknown[]) {},
        stop(...args: unknown[]) {},
      };
      expect(isLifeCycleObserver(obj)).toBe(true);
    });

    it('returns false for object without lifecycle methods', () => {
      const obj = {
        someMethod() {},
        anotherMethod() {},
      };
      expect(isLifeCycleObserver(obj)).toBe(false);
    });

    it('returns false for object with non-function lifecycle properties', () => {
      const obj = {
        start: 'not a function',
        stop: 123,
        init: true,
      };
      expect(isLifeCycleObserver(obj)).toBe(false);
    });

    it('returns false for empty object', () => {
      const obj = {};
      expect(isLifeCycleObserver(obj)).toBe(false);
    });

    it('returns true for class instance with lifecycle methods', () => {
      class MyObserver implements LifeCycleObserver {
        async start() {}
        async stop() {}
      }
      const instance = new MyObserver();
      expect(isLifeCycleObserver(instance)).toBe(true);
    });
  });

  describe('isLifeCycleObserverClass', () => {
    it('returns true for class with start method', () => {
      class MyObserver {
        start() {}
      }
      expect(isLifeCycleObserverClass(MyObserver)).toBe(true);
    });

    it('returns true for class with stop method', () => {
      class MyObserver {
        stop() {}
      }
      expect(isLifeCycleObserverClass(MyObserver)).toBe(true);
    });

    it('returns true for class with init method', () => {
      class MyObserver {
        init() {}
      }
      expect(isLifeCycleObserverClass(MyObserver)).toBe(true);
    });

    it('returns true for class with all lifecycle methods', () => {
      class MyObserver implements LifeCycleObserver {
        init() {}
        start() {}
        stop() {}
      }
      expect(isLifeCycleObserverClass(MyObserver)).toBe(true);
    });

    it('returns true for class with async lifecycle methods', () => {
      class MyObserver implements LifeCycleObserver {
        async init() {}
        async start() {}
        async stop() {}
      }
      expect(isLifeCycleObserverClass(MyObserver)).toBe(true);
    });

    it('returns false for class without lifecycle methods', () => {
      class NotAnObserver {
        someMethod() {}
      }
      expect(isLifeCycleObserverClass(NotAnObserver)).toBe(false);
    });

    it('returns false for empty class', () => {
      class EmptyClass {}
      expect(isLifeCycleObserverClass(EmptyClass)).toBe(false);
    });

    it('returns true for class extending LifeCycleObserver', () => {
      class BaseObserver implements LifeCycleObserver {
        async start() {}
      }
      class DerivedObserver extends BaseObserver {}
      expect(isLifeCycleObserverClass(DerivedObserver)).toBe(true);
    });
  });

  describe('asLifeCycleObserver', () => {
    it('tags binding with LIFE_CYCLE_OBSERVER', () => {
      const binding = new Binding('my.observer');
      asLifeCycleObserver(binding);
      expect(Array.from(binding.tagNames)).toContainEqual(
        CoreTags.LIFE_CYCLE_OBSERVER,
      );
    });

    it('returns the binding for chaining', () => {
      const binding = new Binding('my.observer');
      const result = asLifeCycleObserver(binding);
      expect(result).toBe(binding);
    });

    it('can be used with binding.apply()', () => {
      const binding = new Binding('my.observer').apply(asLifeCycleObserver);
      expect(Array.from(binding.tagNames)).toContainEqual(
        CoreTags.LIFE_CYCLE_OBSERVER,
      );
    });

    it('preserves existing tags', () => {
      const binding = new Binding('my.observer').tag('custom-tag');
      asLifeCycleObserver(binding);
      expect(Array.from(binding.tagNames)).toContainEqual('custom-tag');
      expect(Array.from(binding.tagNames)).toContainEqual(
        CoreTags.LIFE_CYCLE_OBSERVER,
      );
    });

    it('works with class bindings', () => {
      class MyObserver implements LifeCycleObserver {
        async start() {}
      }
      const binding = new Binding('my.observer')
        .toClass(MyObserver)
        .apply(asLifeCycleObserver);
      expect(Array.from(binding.tagNames)).toContainEqual(
        CoreTags.LIFE_CYCLE_OBSERVER,
      );
    });
  });

  describe('lifeCycleObserverFilter', () => {
    let ctx: Context;

    beforeEach(() => {
      ctx = new Context();
    });

    it('filters bindings tagged with LIFE_CYCLE_OBSERVER', () => {
      const binding1 = ctx
        .bind('observer1')
        .to({})
        .tag(CoreTags.LIFE_CYCLE_OBSERVER);
      const binding2 = ctx.bind('observer2').to({});
      const binding3 = ctx
        .bind('observer3')
        .to({})
        .tag(CoreTags.LIFE_CYCLE_OBSERVER);

      const filtered = ctx.find(lifeCycleObserverFilter);
      expect(filtered).toContainEqual(binding1);
      expect(filtered).toContainEqual(binding3);
      expect(filtered).not.toContainEqual(binding2);
    });

    it('returns empty array when no observers are bound', () => {
      ctx.bind('not-observer').to({});
      const filtered = ctx.find(lifeCycleObserverFilter);
      expect(filtered).toHaveLength(0);
    });

    it('works with multiple contexts', () => {
      const parent = new Context();
      const child = new Context(parent);

      parent.bind('parent.observer').to({}).tag(CoreTags.LIFE_CYCLE_OBSERVER);
      child.bind('child.observer').to({}).tag(CoreTags.LIFE_CYCLE_OBSERVER);

      const filtered = child.find(lifeCycleObserverFilter);
      expect(filtered).toHaveLength(2);
    });
  });

  describe('@lifeCycleObserver decorator', () => {
    it('works with @injectable decorator', () => {
      @lifeCycleObserver('my-group')
      @injectable({scope: BindingScope.SINGLETON})
      class MyObserver implements LifeCycleObserver {
        async start() {}
      }

      const ctx = new Context();
      ctx.bind('my.observer').toInjectable(MyObserver);
      const binding = ctx.getBinding('my.observer');
      expect(binding.scope).toBe(BindingScope.SINGLETON);
      expect(Array.from(binding.tagNames)).toContainEqual(
        CoreTags.LIFE_CYCLE_OBSERVER,
      );
    });

    it('can be used without group parameter', () => {
      @lifeCycleObserver()
      class MyObserver implements LifeCycleObserver {
        async start() {}
      }

      const ctx = new Context();
      ctx.bind('my.observer').toInjectable(MyObserver);
      const binding = ctx.getBinding('my.observer');
      expect(binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]).toBe('');
    });
  });

  describe('LifeCycleObserver interface', () => {
    it('allows init method only', () => {
      const observer: LifeCycleObserver = {
        init() {},
      };
      expect(observer.init).toBeInstanceOf(Function);
    });

    it('allows start method only', () => {
      const observer: LifeCycleObserver = {
        start() {},
      };
      expect(observer.start).toBeInstanceOf(Function);
    });

    it('allows stop method only', () => {
      const observer: LifeCycleObserver = {
        stop() {},
      };
      expect(observer.stop).toBeInstanceOf(Function);
    });

    it('allows all methods', () => {
      const observer: LifeCycleObserver = {
        init() {},
        start() {},
        stop() {},
      };
      expect(observer.init).toBeInstanceOf(Function);
      expect(observer.start).toBeInstanceOf(Function);
      expect(observer.stop).toBeInstanceOf(Function);
    });

    it('allows async methods', () => {
      const observer: LifeCycleObserver = {
        async init() {},
        async start() {},
        async stop() {},
      };
      expect(observer.init).toBeInstanceOf(Function);
      expect(observer.start).toBeInstanceOf(Function);
      expect(observer.stop).toBeInstanceOf(Function);
    });

    it('allows methods with injected arguments', () => {
      const observer: LifeCycleObserver = {
        init(...args: unknown[]) {},
        start(...args: unknown[]) {},
        stop(...args: unknown[]) {},
      };
      expect(observer.init).toBeInstanceOf(Function);
      expect(observer.start).toBeInstanceOf(Function);
      expect(observer.stop).toBeInstanceOf(Function);
    });

    it('allows methods returning void', () => {
      const observer: LifeCycleObserver = {
        init(): void {},
        start(): void {},
        stop(): void {},
      };
      expect(observer.init).toBeInstanceOf(Function);
    });

    it('allows methods returning Promise<void>', () => {
      const observer: LifeCycleObserver = {
        init(): Promise<void> {
          return Promise.resolve();
        },
        start(): Promise<void> {
          return Promise.resolve();
        },
        stop(): Promise<void> {
          return Promise.resolve();
        },
      };
      expect(observer.init).toBeInstanceOf(Function);
    });
  });

  describe('Integration scenarios', () => {
    it('works with class implementing LifeCycleObserver', () => {
      @lifeCycleObserver('integration-group')
      class IntegrationObserver implements LifeCycleObserver {
        started = false;
        stopped = false;

        async start() {
          this.started = true;
        }

        async stop() {
          this.stopped = true;
        }
      }

      const ctx = new Context();
      ctx.bind('observer').toInjectable(IntegrationObserver);

      const binding = ctx.getBinding('observer');
      expect(isLifeCycleObserverClass(IntegrationObserver)).toBe(true);
      expect(Array.from(binding.tagNames)).toContainEqual(
        CoreTags.LIFE_CYCLE_OBSERVER,
      );
      expect(binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]).toBe(
        'integration-group',
      );
    });

    it('filters observers by group', () => {
      @lifeCycleObserver('group-a')
      class ObserverA implements LifeCycleObserver {
        async start() {}
      }

      @lifeCycleObserver('group-b')
      class ObserverB implements LifeCycleObserver {
        async start() {}
      }

      const ctx = new Context();
      ctx.bind('observer.a').toInjectable(ObserverA);
      ctx.bind('observer.b').toInjectable(ObserverB);

      const allObservers = ctx.find(lifeCycleObserverFilter);
      expect(allObservers).toHaveLength(2);

      const groupAObservers = ctx.find(
        binding =>
          lifeCycleObserverFilter(binding) &&
          binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP] === 'group-a',
      );
      expect(groupAObservers).toHaveLength(1);
    });
  });
});

// Made with Bob
