// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {
  Binding,
  BindingScope,
  Context,
  ContextView,
  filterByTag,
  Getter,
  inject,
} from '../../index.js';

describe('@inject.* to receive multiple values matching a filter', () => {
  let ctx: Context;
  beforeEach(() => {
    ctx = givenContext();
  });

  it('injects as getter', async () => {
    class MyControllerWithGetter {
      @inject.getter(filterByTag('foo'))
      getter: Getter<string[]>;
    }

    ctx.bind('my-controller').toClass(MyControllerWithGetter);
    const inst = await ctx.get<MyControllerWithGetter>('my-controller');
    const getter = inst.getter;
    expect(getter).toBeInstanceOf(Function);
    expect(await getter()).toEqual(['BAR', 'FOO']);
    // Add a new binding that matches the filter
    ctx.bind('xyz').to('XYZ').tag('foo');
    // The getter picks up the new binding
    expect(await getter()).toEqual(['BAR', 'XYZ', 'FOO']);
  });

  it('injects as values', async () => {
    class MyControllerWithValues {
      constructor(
        @inject(filterByTag('foo'))
        public values: string[],
      ) {}
    }

    ctx.bind('my-controller').toClass(MyControllerWithValues);
    const inst = await ctx.get<MyControllerWithValues>('my-controller');
    expect(inst.values).toEqual(['BAR', 'FOO']);
  });

  it('refuses to inject as a view', async () => {
    class MyControllerWithView {
      @inject(filterByTag('foo'))
      view: ContextView<string[]>;
    }

    ctx.bind('my-controller').toClass(MyControllerWithView);
    await expect(
      ctx.get<MyControllerWithView>('my-controller'),
    ).rejects.toThrow(
      'The type of MyControllerWithView.prototype.view' +
        ' (ContextView) is not Array',
    );
  });

  it('refuses to inject as a getter', async () => {
    class MyControllerWithGetter2 {
      @inject(filterByTag('foo'))
      getter: Getter<string[]>;
    }

    ctx.bind('my-controller').toClass(MyControllerWithGetter2);
    await expect(
      ctx.get<MyControllerWithGetter2>('my-controller'),
    ).rejects.toThrow(
      'The type of MyControllerWithGetter2.prototype.getter' +
        ' (Function) is not Array',
    );
  });
});

function givenContext(bindings: Binding[] = []) {
  const parent = new Context('app');
  const ctx = new Context(parent, 'server');
  bindings.push(
    ctx
      .bind('bar')
      .toDynamicValue(() => Promise.resolve('BAR'))
      .tag('foo', 'bar')
      .inScope(BindingScope.SINGLETON),
  );
  bindings.push(parent.bind('foo').to('FOO').tag('foo', 'bar'));
  return ctx;
}
