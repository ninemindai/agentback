// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {pEvent} from 'p-event';
import {types} from 'util';
import {
  Binding,
  BindingScope,
  BindingTag,
  compareBindingsByTag,
  Context,
  ContextView,
  createBindingFromClass,
  createViewGetter,
  filterByTag,
  injectable,
} from '../../index.js';

describe('ContextView', () => {
  let app: Context;
  let server: ServerContext;

  let bindings: Binding<unknown>[];
  let taggedAsFoo: ContextView;

  beforeEach(givenContextView);

  it('tracks bindings', () => {
    expect(taggedAsFoo.bindings).toEqual(bindings);
  });

  it('leverages findByTag for binding tag filter', () => {
    expect(taggedAsFoo.bindings).toEqual(bindings);
    expect(server.findByTagInvoked).toBe(true);
  });

  it('sorts matched bindings', () => {
    const view = new ContextView(
      server,
      filterByTag('foo'),
      compareBindingsByTag('phase', ['b', 'a']),
    );
    expect(view.bindings).toEqual([bindings[1], bindings[0]]);
  });

  it('allows proxy', async () => {
    @injectable({tags: {service: true}})
    class MyService {
      hello() {
        return 'Hello';
      }
    }
    server.add(createBindingFromClass(MyService));
    const view = new ContextView(server, filterByTag('service'), undefined, {
      asProxyWithInterceptors: true,
    });
    const values = await view.values();
    values.forEach(v => expect(types.isProxy(v)));
  });

  it('resolves bindings', async () => {
    expect(await taggedAsFoo.resolve()).toEqual(['BAR', 'FOO']);
    expect(await taggedAsFoo.values()).toEqual(['BAR', 'FOO']);
  });

  it('resolves bindings as a getter', async () => {
    expect(await taggedAsFoo.asGetter()()).toEqual(['BAR', 'FOO']);
  });

  it('reports error on singleValue() if multiple values exist', async () => {
    return expect(taggedAsFoo.singleValue()).rejects.toThrow(
      /The ContextView has more than one value\. Use values\(\) to access them\./,
    );
  });

  it('supports singleValue() if only one value exist', async () => {
    server.unbind('bar');
    expect(await taggedAsFoo.singleValue()).toEqual('FOO');
  });

  it('reloads bindings after refresh', async () => {
    taggedAsFoo.refresh();
    const abcBinding = server.bind('abc').to('ABC').tag('abc');
    const xyzBinding = server.bind('xyz').to('XYZ').tag('foo');
    expect(taggedAsFoo.bindings).toContainEqual(xyzBinding);
    // `abc` does not have the matching tag
    expect(taggedAsFoo.bindings).not.toMatchObject(abcBinding);
    expect(await taggedAsFoo.values()).toEqual(['BAR', 'XYZ', 'FOO']);
  });

  it('reloads bindings if context bindings are added', async () => {
    const abcBinding = server.bind('abc').to('ABC').tag('abc');
    const xyzBinding = server.bind('xyz').to('XYZ').tag('foo');
    expect(taggedAsFoo.bindings).toContainEqual(xyzBinding);
    // `abc` does not have the matching tag
    expect(taggedAsFoo.bindings).not.toMatchObject(abcBinding);
    expect(await taggedAsFoo.values()).toEqual(['BAR', 'XYZ', 'FOO']);
  });

  it('reloads bindings if context bindings are removed', async () => {
    server.unbind('bar');
    expect(await taggedAsFoo.values()).toEqual(['FOO']);
  });

  it('reloads bindings if context bindings are rebound', async () => {
    server.bind('bar').to('BAR'); // No more tagged with `foo`
    expect(await taggedAsFoo.values()).toEqual(['FOO']);
  });

  it('reloads bindings if parent context bindings are added', async () => {
    const xyzBinding = app.bind('xyz').to('XYZ').tag('foo');
    expect(taggedAsFoo.bindings).toContainEqual(xyzBinding);
    expect(await taggedAsFoo.values()).toEqual(['BAR', 'FOO', 'XYZ']);
  });

  it('reloads bindings if parent context bindings are removed', async () => {
    app.unbind('foo');
    expect(await taggedAsFoo.values()).toEqual(['BAR']);
  });

  it('stops watching', async () => {
    expect(await taggedAsFoo.values()).toEqual(['BAR', 'FOO']);
    taggedAsFoo.close();
    app.unbind('foo');
    expect(await taggedAsFoo.values()).toEqual(['BAR', 'FOO']);
  });

  it('returns a copy of cached values', async () => {
    const values = await taggedAsFoo.values();
    const valuesFromCache = await taggedAsFoo.values();
    expect(values).not.toBe(valuesFromCache); // Not the same array
    expect(values).toEqual(valuesFromCache); // But with the same items
  });

  it('returns a copy of cached values for resolve()', async () => {
    const values = await taggedAsFoo.resolve();
    const valuesFromCache = await taggedAsFoo.resolve();
    expect(values).not.toBe(valuesFromCache); // Not the same array
    expect(values).toEqual(valuesFromCache); // But with the same items
  });

  describe('EventEmitter', () => {
    let events: string[] = [];

    beforeEach(setupListeners);

    it('emits close', () => {
      taggedAsFoo.close();
      expect(events).toEqual(['close']);
      // 2nd close does not emit `close` as it's closed
      taggedAsFoo.close();
      expect(events).toEqual(['close']);
    });

    it('emits refresh', () => {
      taggedAsFoo.refresh();
      expect(events).toEqual(['refresh']);
    });

    it('emits resolve', async () => {
      await taggedAsFoo.values();
      expect(events).toEqual(['resolve']);
      // Second call does not resolve as values are cached
      await taggedAsFoo.values();
      expect(events).toEqual(['resolve']);
    });

    it('emits refresh & resolve when bindings are changed', async () => {
      server.bind('xyz').to('XYZ').tag('foo');
      await taggedAsFoo.values();
      expect(events).toEqual(['bind', 'refresh', 'resolve']);
    });

    it('emits bind/unbind when bindings are changed', async () => {
      const bindingEvents: {cachedValue?: unknown}[] = [];
      taggedAsFoo.on('bind', evt => {
        bindingEvents.push(evt);
      });
      taggedAsFoo.on('unbind', evt => {
        bindingEvents.push(evt);
      });
      const binding = server.bind('xyz').to('XYZ').tag('foo');
      await pEvent(taggedAsFoo, 'bind');
      let values = await taggedAsFoo.values();
      expect(values.sort()).toEqual(['BAR', 'FOO', 'XYZ']);
      const context = server;
      expect(bindingEvents).toEqual([{type: 'bind', binding, context}]);
      server.unbind('xyz');
      await pEvent(taggedAsFoo, 'unbind');
      values = await taggedAsFoo.values();
      expect(values.sort()).toEqual(['BAR', 'FOO']);
      expect(bindingEvents).toEqual([
        {type: 'bind', binding, context},
        {type: 'unbind', binding, context, cachedValue: 'XYZ'},
      ]);
    });

    it('does bot emit bind/unbind when a shadowed binding is changed', async () => {
      const bindingEvents: {cachedValue?: unknown}[] = [];
      taggedAsFoo.on('bind', evt => {
        bindingEvents.push(evt);
      });
      taggedAsFoo.on('unbind', evt => {
        bindingEvents.push(evt);
      });
      // Add a `bar` binding to the parent context
      app.bind('bar').to('BAR from app').tag('foo');
      // The newly added binding is shadowed. No `bind` event will be emitted
      await expect(pEvent(taggedAsFoo, 'bind', {timeout: 50})).rejects.toThrow(
        /Promise timed out after 50 milliseconds/,
      );
      let values = await taggedAsFoo.values();
      expect(values.sort()).toEqual(['BAR', 'FOO']);
      expect(bindingEvents).toEqual([]);
      app.unbind('bar');
      await expect(
        pEvent(taggedAsFoo, 'unbind', {timeout: 50}),
      ).rejects.toThrow(/Promise timed out after 50 milliseconds/);
      values = await taggedAsFoo.values();
      expect(values.sort()).toEqual(['BAR', 'FOO']);
      expect(bindingEvents).toEqual([]);
    });

    function setupListeners() {
      events = [];
      ['close', 'refresh', 'resolve', 'bind', 'unbind'].forEach(t =>
        taggedAsFoo.on(t, () => events.push(t)),
      );
    }
  });

  describe('createViewGetter', () => {
    it('creates a getter function for the binding filter', async () => {
      const getter = createViewGetter(server, filterByTag('foo'));
      expect(await getter()).toEqual(['BAR', 'FOO']);
      server.bind('abc').to('ABC').tag('abc');
      server.bind('xyz').to('XYZ').tag('foo');
      expect(await getter()).toEqual(['BAR', 'XYZ', 'FOO']);
    });

    it('creates a getter function for the binding filter and comparator', async () => {
      const getter = createViewGetter(server, filterByTag('foo'), (a, b) => {
        return a.key.localeCompare(b.key);
      });
      expect(await getter()).toEqual(['BAR', 'FOO']);
      server.bind('abc').to('ABC').tag('abc');
      server.bind('xyz').to('XYZ').tag('foo');
      expect(await getter()).toEqual(['BAR', 'FOO', 'XYZ']);
    });

    it('creates a getter function for proxy', async () => {
      @injectable({tags: {service: true}})
      class MyService {
        hello() {
          return 'Hello';
        }
      }
      server.add(createBindingFromClass(MyService));
      const getter = createViewGetter(
        server,
        filterByTag('service'),
        undefined,
        {
          asProxyWithInterceptors: true,
        },
      );
      const result = await getter();
      result.forEach(v => expect(types.isProxy(v)).toBe(true));
    });
  });

  function givenContextView() {
    bindings = [];
    givenContext();
    taggedAsFoo = server.createView(filterByTag('foo'));
  }

  class ServerContext extends Context {
    findByTagInvoked = false;
    constructor(parent: Context, name: string) {
      super(parent, name);
    }

    _findByTagIndex(tag: BindingTag) {
      this.findByTagInvoked = true;
      return super._findByTagIndex(tag);
    }
  }

  function givenContext() {
    app = new Context('app');
    server = new ServerContext(app, 'server');
    bindings.push(
      server
        .bind('bar')
        .toDynamicValue(() => Promise.resolve('BAR'))
        .tag('foo', 'bar', {phase: 'a'})
        .inScope(BindingScope.SINGLETON),
    );
    bindings.push(app.bind('foo').to('FOO').tag('foo', 'bar', {phase: 'b'}));
  }
});
