// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, describe as context, expect} from 'vitest';

import {BindingKey, Context} from '../../index.js';

describe('Context bindings - Creating and resolving bindings', () => {
  let ctx: Context;
  beforeAll(createContext);

  describe('Simple bindings', () => {
    describe('when a simple binding', () => {
      context('is created with key `foo` and bound to value `bar`', () => {
        beforeAll(createBinding);

        it('registers key `foo` into the context', () => {
          expect(ctx.contains('foo')).toBe(true);
        });

        it('returns the bound value `bar`', async () => {
          const result = await ctx.get('foo');
          expect(result).toBe('bar');
        });

        it('supports sync retrieval of the bound value', () => {
          const result = ctx.getSync('foo');
          expect(result).toBe('bar');
        });

        function createBinding() {
          ctx.bind('foo').to('bar');
        }
      });
    });

    context('with type information', () => {
      it('infers correct type when getting the value', async () => {
        const key = BindingKey.create<string>('foo');
        ctx.bind(key).to('value');
        const value = await ctx.get(key);
        // The following line is accessing a String property as a way
        // of verifying the value type at compile time
        expect(value.length).toBe(5);
      });

      it('allows access to a deep property', async () => {
        const key = BindingKey.create<object>('foo');
        ctx.bind(key).to({rest: {port: 80}});
        const value = await ctx.get(key.deepProperty<number>('rest.port'));
        // The following line is accessing a Number property as a way
        // of verifying the value type at compile time
        expect(value.toFixed()).toBe('80');
      });

      it('infers a complex type when getting the value', async () => {
        interface SomeData {
          foo: string;
        }
        const key = BindingKey.create<SomeData>('foo');
        ctx.bind(key).to({foo: 'bar'});
        const value = await ctx.get(key);
        expect(value.foo).toBe('bar');
      });
    });
  });

  describe('Dynamic bindings', () => {
    describe('when a dynamic binding is created with three values', () => {
      beforeAll(createDynamicBinding);

      context('resolving the binding for the first time', () => {
        it('returns the first value', async () => {
          const result = await ctx.get('data');
          expect(result).toBe('a');
        });
      });

      context('resolving the binding for the second time', () => {
        it('returns the second value', async () => {
          const result = await ctx.get('data');
          expect(result).toBe('b');
        });
      });

      context('resolving the binding for the third time', () => {
        it('returns the third value', async () => {
          const result = await ctx.get('data');
          expect(result).toBe('c');
        });
      });

      function createDynamicBinding() {
        const data = ['a', 'b', 'c'];
        ctx.bind('data').toDynamicValue(function () {
          return data.shift() ?? '(empty)';
        });
      }
    });

    it('can resolve synchronously when the factory function is sync', () => {
      ctx.bind('data').toDynamicValue(() => 'value');
      const result = ctx.getSync('data');
      expect(result).toBe('value');
    });
  });

  function createContext() {
    ctx = new Context();
  }
});
