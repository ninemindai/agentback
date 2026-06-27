// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {Binding, BindingTag, Context, filterByTag} from '../../index.js';

/**
 * Create a subclass of context so that we can access parents and registry
 * for assertions
 */
class TestContext extends Context {
  constructor() {
    super('app');
  }

  get parent() {
    return this._parent;
  }

  get bindingMap() {
    const map = new Map(this.registry);
    return map;
  }

  get tagIndex() {
    return this.tagIndexer.bindingsIndexedByTag;
  }

  findByTagInvoked = false;

  _findByTagIndex(tag: BindingTag | RegExp) {
    this.findByTagInvoked = true;
    return super._findByTagIndex(tag);
  }
}

describe('Context with tag indexer', () => {
  let ctx: TestContext;
  beforeEach(createContext);

  describe('bind', () => {
    it('indexes a binding by tag', () => {
      const binding = ctx.bind('foo').tag('a', {b: 1});
      assertBindingIndexedByTag(binding, 'a', 'b');
    });

    it('indexes a binding by tag after being bound', () => {
      const binding = ctx.bind('foo');
      assertBindingNotIndexedByTag(binding, 'a', 'b');
      binding.tag('a', {b: 1});
      assertBindingIndexedByTag(binding, 'a', 'b');
    });
  });

  describe('add', () => {
    it('indexes a binding by tag', () => {
      const binding = new Binding('foo').to('bar').tag('a', {b: 1});
      ctx.add(binding);
      assertBindingIndexedByTag(binding, 'a', 'b');
    });

    it('indexes a binding by tag after being bound', () => {
      const binding = new Binding('foo').to('bar');
      ctx.add(binding);
      assertBindingNotIndexedByTag(binding, 'a', 'b');
      binding.tag('a', {b: 1});
      assertBindingIndexedByTag(binding, 'a', 'b');
    });
  });

  describe('unbind', () => {
    it('removes indexes for a binding by tag', () => {
      const binding = ctx.bind('foo').to('bar').tag('a', {b: 1});
      assertBindingIndexedByTag(binding, 'a', 'b');
      ctx.unbind(binding.key);
      assertBindingNotIndexedByTag(binding, 'a', 'b');
    });
  });

  describe('find', () => {
    it('leverages binding index by tag', () => {
      ctx.bind('foo');
      const b2 = ctx.bind('bar').tag('b');
      const b3 = ctx.bind('baz').tag('b');
      const result = ctx.find(filterByTag('b'));
      expect(result).toEqual([b2, b3]);
      expect(ctx.findByTagInvoked).toBe(true);
    });

    it('leverages binding index by tag wildcard', () => {
      ctx.bind('foo');
      const b2 = ctx.bind('bar').tag('b2');
      const b3 = ctx.bind('baz').tag('b3');
      const result = ctx.find(filterByTag('b?'));
      expect(result).toEqual([b2, b3]);
      expect(ctx.findByTagInvoked).toBe(true);
    });

    it('leverages binding index by tag regexp', () => {
      ctx.bind('foo');
      const b2 = ctx.bind('bar').tag('b2');
      const b3 = ctx.bind('baz').tag('b3');
      const result = ctx.find(filterByTag(/b\d/));
      expect(result).toEqual([b2, b3]);
      expect(ctx.findByTagInvoked).toBe(true);
    });

    it('leverages binding index by tag name/value pairs', () => {
      ctx.bind('foo');
      const b2 = ctx.bind('bar').tag({a: 1});
      ctx.bind('baz').tag({a: 2, b: 1});
      const result = ctx.find(filterByTag({a: 1}));
      expect(result).toEqual([b2]);
      expect(ctx.findByTagInvoked).toBe(true);
    });
  });

  function createContext() {
    ctx = new TestContext();
  }

  function assertBindingIndexedByTag(
    binding: Binding<unknown>,
    ...tags: string[]
  ) {
    for (const t of tags) {
      expect(ctx.tagIndex.get(t)?.has(binding)).toBe(true);
    }
  }

  function assertBindingNotIndexedByTag(
    binding: Binding<unknown>,
    ...tags: string[]
  ) {
    for (const t of tags) {
      expect(!!ctx.tagIndex.get(t)?.has(binding)).toBe(false);
    }
  }
});
