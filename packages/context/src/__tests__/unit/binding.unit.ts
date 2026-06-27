// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';
import {sinon, SinonSpy} from '@agentback/testlab';
import {
  Binding,
  BindingEvent,
  BindingKey,
  BindingScope,
  BindingType,
  config,
  Context,
  filterByTag,
  inject,
  injectable,
  Provider,
  ValueFactory,
} from '../../index.js';

const key = 'foo';

describe('Binding', () => {
  let ctx: Context;
  let binding: Binding;
  beforeEach(givenBinding);

  describe('constructor', () => {
    it('sets the given key', () => {
      const result = binding.key;
      expect(result).toBe(key);
    });

    it('sets the binding lock state to unlocked by default', () => {
      expect(binding.isLocked).toBe(false);
    });

    it('leaves other states to `undefined` by default', () => {
      expect(binding.type).toBeUndefined();
      expect(binding.source).toBeUndefined();
      expect(binding.valueConstructor).toBeUndefined();
      expect(binding.providerConstructor).toBeUndefined();
    });
  });

  describe('lock', () => {
    it('locks the binding', () => {
      binding.lock();
      expect(binding.isLocked).toBe(true);
    });
  });

  describe('tag', () => {
    it('tags the binding', () => {
      binding.tag('t1');
      expect(binding.tagNames).toEqual(['t1']);
      binding.tag('t2');
      expect(binding.tagNames).toEqual(['t1', 't2']);
      expect(binding.tagMap).toEqual({t1: 't1', t2: 't2'});
    });

    it('tags the binding with rest args', () => {
      binding.tag('t1', 't2');
      expect(binding.tagNames).toEqual(['t1', 't2']);
    });

    it('tags the binding with name/value', () => {
      binding.tag({name: 'my-controller'});
      expect(binding.tagNames).toEqual(['name']);
      expect(binding.tagMap).toEqual({name: 'my-controller'});
    });

    it('tags the binding with names and name/value objects', () => {
      binding.tag('controller', {name: 'my-controller'}, 'rest');
      expect(binding.tagNames).toEqual(['controller', 'name', 'rest']);
      expect(binding.tagMap).toEqual({
        controller: 'controller',
        name: 'my-controller',
        rest: 'rest',
      });
    });

    it('throws an error if one of the arguments is an array', () => {
      expect(() => binding.tag(['t1', 't2'])).toThrow(
        /Tag must be a string or an object \(but not array\):/,
      );
    });

    it('triggers changed event', () => {
      const events = listenOnBinding();
      binding.tag('t1');
      assertEvents(events, 'tag');
    });
  });

  describe('inScope', () => {
    it('defaults to `TRANSIENT` binding scope', () => {
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
    });

    it('sets the singleton binding scope', () => {
      binding.inScope(BindingScope.SINGLETON);
      expect(binding.scope).toBe(BindingScope.SINGLETON);
    });

    it('sets the context binding scope', () => {
      binding.inScope(BindingScope.CONTEXT);
      expect(binding.scope).toBe(BindingScope.CONTEXT);
    });

    it('sets the transient binding scope', () => {
      binding.inScope(BindingScope.TRANSIENT);
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
    });

    it('sets the request binding scope', () => {
      binding.inScope(BindingScope.REQUEST);
      expect(binding.scope).toBe(BindingScope.REQUEST);
    });

    it('sets the application binding scope', () => {
      binding.inScope(BindingScope.APPLICATION);
      expect(binding.scope).toBe(BindingScope.APPLICATION);
    });

    it('sets the server binding scope', () => {
      binding.inScope(BindingScope.SERVER);
      expect(binding.scope).toBe(BindingScope.SERVER);
    });

    it('triggers changed event', () => {
      const events = listenOnBinding();
      binding.inScope(BindingScope.TRANSIENT);
      assertEvents(events, 'scope');
    });
  });

  describe('applyDefaultScope', () => {
    it('sets the scope if not set', () => {
      binding.applyDefaultScope(BindingScope.SINGLETON);
      expect(binding.scope).toBe(BindingScope.SINGLETON);
    });

    it('does not override the existing scope', () => {
      binding.inScope(BindingScope.TRANSIENT);
      binding.applyDefaultScope(BindingScope.SINGLETON);
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
    });
  });

  describe('to(value)', () => {
    it('returns the value synchronously', () => {
      binding.to('value');
      expect(binding.getValue(ctx)).toBe('value');
    });

    it('sets the type to CONSTANT', () => {
      binding.to('value');
      expect(binding.type).toBe(BindingType.CONSTANT);
      expect(binding.source?.value).toBe('value');
    });

    it('triggers changed event', () => {
      const events = listenOnBinding();
      binding.to('value');
      assertEvents(events, 'value');
    });

    it('rejects promise values', () => {
      expect(() => binding.to(Promise.resolve('value'))).toThrow(
        /Promise instances are not allowed.*toDynamicValue/,
      );
    });

    it('rejects rejected promise values', () => {
      const p = Promise.reject('error');
      expect(() => binding.to(p)).toThrow(
        /Promise instances are not allowed.*toDynamicValue/,
      );
      // Catch the rejected promise to avoid
      // (node:60994) UnhandledPromiseRejectionWarning: Unhandled promise
      // rejection (rejection id: 1): error
      p.catch(e => {});
    });
  });

  describe('toDynamicValue(dynamicValueFn)', () => {
    it('support a factory', async () => {
      const factory = () => Promise.resolve('hello');
      const b = ctx.bind('msg').toDynamicValue(factory);
      expect(b.type).toBe(BindingType.DYNAMIC_VALUE);
      expect(b.source?.value).toBe(factory);

      const value = await ctx.get<string>('msg');
      expect(value).toBe('hello');
      expect(b.type).toBe(BindingType.DYNAMIC_VALUE);
    });

    it('support a factory to access context/binding/session', async () => {
      const factory: ValueFactory<string> = ({
        context,
        binding: _binding,
        options,
      }) => {
        return `Hello, ${context.name}#${
          _binding.key
        } ${options.session?.getBindingPath()}`;
      };
      const b = ctx.bind('msg').toDynamicValue(factory);
      expect(b.type).toBe(BindingType.DYNAMIC_VALUE);
      expect(b.source?.value).toBe(factory);
      const value = await ctx.get<string>('msg');
      expect(value).toBe('Hello, test#msg msg');
      expect(b.type).toBe(BindingType.DYNAMIC_VALUE);
    });

    it('supports a factory to use context to look up a binding', async () => {
      ctx.bind('user').to('John');
      ctx.bind('greeting').toDynamicValue(async ({context}) => {
        const user = await context.get('user');
        return `Hello, ${user}`;
      });
      const value = await ctx.get<string>('greeting');
      expect(value).toEqual('Hello, John');
    });

    it('supports a factory to use static provider', () => {
      class GreetingProvider {
        static value(@inject('user') user: string) {
          return `Hello, ${user}`;
        }
      }
      ctx.bind('user').to('John');
      ctx.bind('greeting').toDynamicValue(GreetingProvider);
      const value = ctx.getSync<string>('greeting');
      expect(value).toEqual('Hello, John');
    });

    it('supports a factory to use async static provider', async () => {
      class GreetingProvider {
        static async value(@inject('user') user: string) {
          return `Hello, ${user}`;
        }
      }
      ctx.bind('user').to('John');
      const b = ctx.bind('greeting').toDynamicValue(GreetingProvider);
      expect(b.type).toBe(BindingType.DYNAMIC_VALUE);
      expect(b.source).toEqual({
        type: BindingType.DYNAMIC_VALUE,
        value: GreetingProvider,
      });
      const value = await ctx.get<string>('greeting');
      expect(value).toEqual('Hello, John');
    });

    it('supports a factory to use async static provider to inject binding', async () => {
      class GreetingProvider {
        static async value(
          @inject('user') user: string,
          @inject.binding() currentBinding: Binding,
        ) {
          return `[${currentBinding.key}] Hello, ${user}`;
        }
      }
      ctx.bind('user').to('John');
      const b = ctx.bind('greeting').toDynamicValue(GreetingProvider);
      expect(b.type).toBe(BindingType.DYNAMIC_VALUE);
      expect(b.source).toEqual({
        type: BindingType.DYNAMIC_VALUE,
        value: GreetingProvider,
      });
      const value = await ctx.get<string>('greeting');
      expect(value).toEqual('[greeting] Hello, John');
    });

    it('supports a factory to use async static provider to inject config', async () => {
      type GreetingConfig = {
        prefix: string;
      };

      class GreetingProvider {
        static async value(
          @inject('user') user: string,
          @config() cfg: GreetingConfig,
        ) {
          return `[${cfg.prefix}] Hello, ${user}`;
        }
      }
      ctx.bind('user').to('John');
      const b = ctx.bind('greeting').toDynamicValue(GreetingProvider);
      expect(b.type).toBe(BindingType.DYNAMIC_VALUE);
      expect(b.source).toEqual({
        type: BindingType.DYNAMIC_VALUE,
        value: GreetingProvider,
      });
      ctx.configure(b.key).to({prefix: '***'});
      const value = await ctx.get<string>('greeting');
      expect(value).toEqual('[***] Hello, John');
    });

    it('triggers changed event', () => {
      const events = listenOnBinding();
      binding.toDynamicValue(() => Promise.resolve('hello'));
      assertEvents(events, 'value');
    });
  });

  describe('toClass(cls)', () => {
    it('support a class', async () => {
      ctx.bind('msg').toDynamicValue(() => Promise.resolve('world'));
      ctx.bind('myService').toClass(MyService);
      const myService = await ctx.get<MyService>('myService');
      expect(myService.getMessage()).toBe('hello world');
    });

    it('sets the type to CLASS', async () => {
      const b = ctx.bind('myService').toClass(MyService);
      expect(b.type).toBe(BindingType.CLASS);
      expect(b.source?.value).toBe(MyService);
    });

    it('triggers changed event', () => {
      const events = listenOnBinding();
      binding.toClass(MyService);
      assertEvents(events, 'value');
    });
  });

  describe('toProvider(provider)', () => {
    it('binding returns the expected value', async () => {
      ctx.bind('msg').to('hello');
      ctx.bind('provider_key').toProvider(MyProvider);
      const value = await ctx.get<string>('provider_key');
      expect(value).toBe('hello world');
    });

    it('can resolve provided value synchronously', () => {
      ctx.bind('msg').to('hello');
      ctx.bind('provider_key').toProvider(MyProvider);
      const value: string = ctx.getSync('provider_key');
      expect(value).toBe('hello world');
    });

    it('support asynchronous dependencies of provider class', async () => {
      ctx.bind('msg').toDynamicValue(() => Promise.resolve('hello'));
      ctx.bind('provider_key').toProvider(MyProvider);
      const value = await ctx.get<string>('provider_key');
      expect(value).toBe('hello world');
    });

    it('sets the type to PROVIDER', () => {
      ctx.bind('msg').to('hello');
      const b = ctx.bind('provider_key').toProvider(MyProvider);
      expect(b.type).toBe(BindingType.PROVIDER);
      expect(b.source?.value).toBe(MyProvider);
    });

    it('sets the providerConstructor', () => {
      ctx.bind('msg').to('hello');
      const b = ctx.bind('provider_key').toProvider(MyProvider);
      expect(b.providerConstructor).toBe(MyProvider);
    });

    it('triggers changed event', () => {
      const events = listenOnBinding();
      binding.toProvider(MyProvider);
      assertEvents(events, 'value');
    });
  });

  describe('toInjectable(class)', () => {
    it('binds to a class', async () => {
      ctx.bind('msg').toDynamicValue(() => Promise.resolve('world'));
      const serviceBinding = ctx.bind('myService').toInjectable(MyService);
      expect(serviceBinding.type).toEqual(BindingType.CLASS);
      const myService = await ctx.get<MyService>('myService');
      expect(myService.getMessage()).toBe('hello world');
    });

    it('binds to a class with @injectable', async () => {
      @injectable({scope: BindingScope.SINGLETON, tags: {x: 1}})
      class MyInjectableService {
        constructor(@inject('msg') private _msg: string) {}

        getMessage(): string {
          return 'hello ' + this._msg;
        }
      }
      ctx.bind('msg').toDynamicValue(() => Promise.resolve('world'));
      const serviceBinding = ctx
        .bind('myService')
        .toInjectable(MyInjectableService);
      expect(serviceBinding.type).toEqual(BindingType.CLASS);
      expect(serviceBinding.scope).toEqual(BindingScope.SINGLETON);
      expect(serviceBinding.tagMap.x).toEqual(1);
      const myService = await ctx.get<MyInjectableService>('myService');
      expect(myService.getMessage()).toBe('hello world');
    });

    it('binds to a provider', async () => {
      ctx.bind('msg').to('hello');
      const providerBinding = ctx.bind('provider_key').toInjectable(MyProvider);
      expect(providerBinding.type).toEqual(BindingType.PROVIDER);
      const value = await ctx.get<string>('provider_key');
      expect(value).toBe('hello world');
    });

    it('binds to a dynamic value provider class', async () => {
      ctx.bind('msg').to('hello');
      const providerBinding = ctx
        .bind('provider_key')
        .toInjectable(MyDynamicValueProvider);
      expect(providerBinding.type).toEqual(BindingType.DYNAMIC_VALUE);
      const value = await ctx.get<string>('provider_key');
      expect(value).toBe('hello world');
    });
  });

  describe('toAlias(bindingKeyWithPath)', () => {
    it('binds to another binding with sync value', () => {
      ctx.bind('parent.options').to({child: {disabled: true}});
      ctx.bind('child.options').toAlias('parent.options#child');
      const childOptions = ctx.getSync('child.options');
      expect(childOptions).toEqual({disabled: true});
    });

    it('creates the alias even when the target is not bound yet', () => {
      ctx.bind('child.options').toAlias('parent.options#child');
      ctx.bind('parent.options').to({child: {disabled: true}});
      const childOptions = ctx.getSync('child.options');
      expect(childOptions).toEqual({disabled: true});
    });

    it('binds to another binding with async value', async () => {
      ctx
        .bind('parent.options')
        .toDynamicValue(() => Promise.resolve({child: {disabled: true}}));
      ctx.bind('child.options').toAlias('parent.options#child');
      const childOptions = await ctx.get('child.options');
      expect(childOptions).toEqual({disabled: true});
    });

    it('reports error if alias binding cannot be resolved', () => {
      ctx.bind('child.options').toAlias('parent.options#child');
      expect(() => ctx.getSync('child.options')).toThrow(
        /The key 'parent.options' is not bound to any value in context/,
      );
    });

    it('reports error if alias binding cannot be resolved - async', async () => {
      ctx.bind('child.options').toAlias('parent.options#child');
      return expect(ctx.get('child.options')).rejects.toThrow(
        /The key 'parent.options' is not bound to any value in context/,
      );
    });

    it('allows optional if binding does not have a value getter', () => {
      // This can happen for `@inject.binding`
      ctx.bind('child.options');
      const childOptions = ctx.getSync('child.options', {optional: true});
      expect(childOptions).toBeUndefined();
    });

    it('allows optional if alias binding cannot be resolved', () => {
      ctx.bind('child.options').toAlias('parent.options#child');
      const childOptions = ctx.getSync('child.options', {optional: true});
      expect(childOptions).toBeUndefined();
    });

    it('allows optional if alias binding cannot be resolved - async', async () => {
      ctx.bind('child.options').toAlias('parent.options#child');
      const childOptions = await ctx.get('child.options', {optional: true});
      expect(childOptions).toBeUndefined();
    });

    it('sets the type to ALIAS', () => {
      const childBinding = ctx
        .bind('child.options')
        .toAlias('parent.options#child');
      expect(childBinding.type).toBe(BindingType.ALIAS);
      expect(childBinding.source).toEqual({
        type: BindingType.ALIAS,
        value: 'parent.options#child',
      });
    });

    it('triggers changed event', () => {
      const events = listenOnBinding();
      binding.toAlias('parent.options#child');
      assertEvents(events, 'value');
    });
  });

  describe('apply(templateFn)', () => {
    it('applies a template function', async () => {
      binding.apply(b => {
        b.inScope(BindingScope.SINGLETON).tag('myTag');
      });
      expect(binding.scope).toEqual(BindingScope.SINGLETON);
      expect(binding.tagNames).toEqual(['myTag']);
    });

    it('applies multiple template functions', async () => {
      binding.apply(
        b => {
          b.inScope(BindingScope.SINGLETON);
        },
        b => {
          b.tag('myTag');
        },
      );
      expect(binding.scope).toEqual(BindingScope.SINGLETON);
      expect(binding.tagNames).toEqual(['myTag']);
    });

    it('sets up a placeholder value', async () => {
      const toBeBound = (b: Binding<unknown>) => {
        b.toDynamicValue(() => {
          throw new Error(`Binding ${b.key} is not bound to a value yet`);
        });
      };
      binding.apply(toBeBound);
      ctx.add(binding);
      await expect(ctx.get(binding.key)).rejects.toThrow(
        /Binding foo is not bound to a value yet/,
      );
    });
  });

  describe('cache', () => {
    let spy: SinonSpy;
    beforeEach(() => {
      spy = sinon.spy();
    });

    it('clears cache if scope changes', () => {
      const indexBinding = ctx
        .bind<number>('index')
        .toDynamicValue(spy)
        .inScope(BindingScope.SINGLETON);

      ctx.getSync(indexBinding.key);
      sinon.assert.calledOnce(spy);
      spy.resetHistory();

      // Singleton
      ctx.getSync(indexBinding.key);
      sinon.assert.notCalled(spy);
      spy.resetHistory();

      indexBinding.inScope(BindingScope.CONTEXT);
      ctx.getSync(indexBinding.key);
      sinon.assert.calledOnce(spy);
    });

    it('clears cache if _getValue changes', () => {
      const providerSpy = sinon.spy();
      class IndexProvider implements Provider<number> {
        value() {
          return providerSpy();
        }
      }
      const indexBinding = ctx
        .bind<number>('index')
        .toDynamicValue(spy)
        .inScope(BindingScope.SINGLETON);

      ctx.getSync(indexBinding.key);
      sinon.assert.calledOnce(spy);
      spy.resetHistory();

      // Singleton
      ctx.getSync(indexBinding.key);
      sinon.assert.notCalled(spy);
      spy.resetHistory();

      // Now change the value getter
      indexBinding.toProvider(IndexProvider);
      ctx.getSync(indexBinding.key);
      sinon.assert.notCalled(spy);
      sinon.assert.calledOnce(providerSpy);
      spy.resetHistory();
      providerSpy.resetHistory();

      // Singleton
      ctx.getSync(indexBinding.key);
      sinon.assert.notCalled(spy);
      sinon.assert.notCalled(providerSpy);
    });
  });

  describe('toJSON()', () => {
    it('converts a keyed binding to plain JSON object', () => {
      const json = binding.toJSON();
      expect(json).toEqual({
        key: key,
        scope: BindingScope.TRANSIENT,
        tags: {},
        isLocked: false,
      });
    });

    it('converts a binding with more attributes to plain JSON object', () => {
      const myBinding = new Binding(key, true)
        .inScope(BindingScope.CONTEXT)
        .tag('model', {name: 'my-model'})
        .to('a');
      const json = myBinding.toJSON();
      expect(json).toEqual({
        key: key,
        scope: BindingScope.CONTEXT,
        tags: {model: 'model', name: 'my-model'},
        isLocked: true,
        type: BindingType.CONSTANT,
      });
    });

    it('converts a keyed binding with alias to plain JSON object', () => {
      const myBinding = new Binding(key)
        .inScope(BindingScope.TRANSIENT)
        .toAlias(BindingKey.create('b', 'x'));
      const json = myBinding.toJSON();
      expect(json).toEqual({
        key: key,
        scope: BindingScope.TRANSIENT,
        tags: {},
        isLocked: false,
        type: BindingType.ALIAS,
        alias: 'b#x',
      });
    });
  });

  describe('inspect()', () => {
    it('converts a keyed binding to plain JSON object', () => {
      const json = binding.inspect();
      expect(json).toEqual({
        key: key,
        scope: BindingScope.TRANSIENT,
        tags: {},
        isLocked: false,
      });
    });

    it('converts a binding with more attributes to plain JSON object', () => {
      const myBinding = new Binding(key, true)
        .inScope(BindingScope.CONTEXT)
        .tag('model', {name: 'my-model'})
        .to('a');
      const json = myBinding.inspect();
      expect(json).toEqual({
        key: key,
        scope: BindingScope.CONTEXT,
        tags: {model: 'model', name: 'my-model'},
        isLocked: true,
        type: BindingType.CONSTANT,
      });
    });

    it('converts a binding with toDynamicValue to plain JSON object', () => {
      const myBinding = new Binding(key)
        .inScope(BindingScope.SINGLETON)
        .tag('model', {name: 'my-model'})
        .toDynamicValue(() => 'a');
      const json = myBinding.inspect({includeInjections: true});
      expect(json).toEqual({
        key: key,
        scope: BindingScope.SINGLETON,
        tags: {model: 'model', name: 'my-model'},
        isLocked: false,
        type: BindingType.DYNAMIC_VALUE,
      });
    });

    it('converts a binding with valueConstructor to plain JSON object', () => {
      function myFilter(b: Readonly<Binding<unknown>>) {
        return b.key.startsWith('timers.');
      }

      class MyController {
        @inject('y', {optional: true})
        private y: number | undefined;

        @inject(filterByTag('task'))
        private tasks: unknown[];

        @inject(myFilter)
        private timers: unknown[];

        constructor(@inject('x') private x: string) {}
      }
      const myBinding = new Binding(key, true)
        .tag('model', {name: 'my-model'})
        .toClass(MyController);
      const json = myBinding.inspect({includeInjections: true});
      expect(json).toEqual({
        key: key,
        scope: BindingScope.TRANSIENT,
        tags: {model: 'model', name: 'my-model'},
        isLocked: true,
        type: BindingType.CLASS,
        valueConstructor: 'MyController',
        injections: {
          constructorArguments: [
            {targetName: 'MyController.constructor[0]', bindingKey: 'x'},
          ],
          properties: {
            y: {
              targetName: 'MyController.prototype.y',
              bindingKey: 'y',
              optional: true,
            },
            tasks: {
              targetName: 'MyController.prototype.tasks',
              bindingTagPattern: 'task',
            },
            timers: {
              targetName: 'MyController.prototype.timers',
              bindingFilter: 'myFilter',
            },
          },
        },
      });
    });

    it('converts a binding with providerConstructor to plain JSON object', () => {
      class MyProvider implements Provider<string> {
        @inject('y')
        private y: number;

        @inject(filterByTag('task'))
        private tasks: unknown[];

        constructor(@inject('x') private x: string) {}

        value() {
          return `${this.x}: ${this.y}`;
        }
      }
      const myBinding = new Binding(key, true)
        .inScope(BindingScope.CONTEXT)
        .tag('model', {name: 'my-model'})
        .toProvider(MyProvider);
      const json = myBinding.inspect({includeInjections: true});
      expect(json).toEqual({
        key: key,
        scope: BindingScope.CONTEXT,
        tags: {model: 'model', name: 'my-model'},
        isLocked: true,
        type: BindingType.PROVIDER,
        providerConstructor: 'MyProvider',
        injections: {
          constructorArguments: [
            {targetName: 'MyProvider.constructor[0]', bindingKey: 'x'},
          ],
          properties: {
            y: {targetName: 'MyProvider.prototype.y', bindingKey: 'y'},
            tasks: {
              targetName: 'MyProvider.prototype.tasks',
              bindingTagPattern: 'task',
            },
          },
        },
      });
    });
  });

  function givenBinding() {
    ctx = new Context('test');
    binding = new Binding(key);
  }

  function listenOnBinding() {
    const events: BindingEvent[] = [];
    binding.on('changed', event => {
      events.push(event);
    });
    return events;
  }

  function assertEvents(events: BindingEvent[], operation: string) {
    expect(events).toEqual([{binding, operation, type: 'changed'}]);
  }

  class MyProvider implements Provider<string> {
    constructor(@inject('msg') private _msg: string) {}
    value(): string {
      return this._msg + ' world';
    }
  }

  class MyService {
    constructor(@inject('msg') private _msg: string) {}

    getMessage(): string {
      return 'hello ' + this._msg;
    }
  }

  class MyDynamicValueProvider {
    static value(@inject('msg') _msg: string): string {
      return _msg + ' world';
    }
  }
});
