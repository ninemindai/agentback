// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, expect} from 'vitest';

import {BoundValue, Context} from '../../index.js';

describe('Context bindings - Finding bindings', () => {
  let ctx: Context;

  describe('Finding all binding', () => {
    beforeAll(createContext);
    beforeAll(() => {
      createBinding('foo', 'bar');
      createBinding('baz', 'qux');
    });

    describe('when I find all bindings', () => {
      it('returns all bindings', () => {
        const bindings = ctx.find();
        const keys = bindings.map(binding => {
          return binding.key;
        });
        expect(keys).toMatchObject(['foo', 'baz']);
      });
    });
  });

  describe('Finding bindings by pattern', () => {
    beforeAll(createContext);
    beforeAll(() => {
      createBinding('my.foo', 'bar');
      createBinding('my.baz', 'qux');
      createBinding('ur.quux', 'quuz');
    });

    describe('when I find all bindings using a pattern', () => {
      it('returns all bindings matching the pattern', () => {
        const bindings = ctx.find('my.*');
        const keys = bindings.map(binding => binding.key);
        expect(keys).toMatchObject(['my.foo', 'my.baz']);
        expect(keys).not.toMatchObject(['ur.quux']);
      });
    });
  });

  describe('Finding bindings by tag', () => {
    beforeAll(createContext);
    beforeAll(createTaggedBindings);

    describe('when I find binding by tag', () => {
      it('returns all bindings matching the tag', () => {
        const bindings = ctx.findByTag('dog');
        const dogs = bindings.map(binding => binding.key);
        expect(dogs).toMatchObject(['spot', 'fido']);
      });
    });

    function createTaggedBindings() {
      class Dog {}
      ctx.bind('spot').to(new Dog()).tag('dog');
      ctx.bind('fido').to(new Dog()).tag('dog');
    }
  });

  function createContext() {
    ctx = new Context();
  }
  function createBinding(key: string, value: BoundValue) {
    ctx.bind(key).to(value);
  }
});
