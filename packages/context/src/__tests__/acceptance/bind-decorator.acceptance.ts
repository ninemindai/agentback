// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {
  BindingScope,
  Context,
  createBindingFromClass,
  injectable,
  Provider,
} from '../../index.js';

describe('@injectable - customize classes with binding attributes', () => {
  @injectable({
    scope: BindingScope.SINGLETON,
    tags: ['service'],
  })
  class MyService {}

  @injectable.provider({
    tags: {
      key: 'my-date-provider',
    },
  })
  class MyDateProvider implements Provider<Date> {
    value() {
      return new Date();
    }
  }

  @injectable({
    tags: ['controller', {name: 'my-controller', type: 'controller'}],
  })
  class MyController {}

  const discoveredClasses = [MyService, MyDateProvider, MyController];

  it('allows discovery of classes to be bound', () => {
    const ctx = new Context();
    discoveredClasses.forEach(c => {
      const binding = createBindingFromClass(c);
      if (binding.tagMap.controller) {
        ctx.add(binding);
      }
    });
    expect(ctx.findByTag('controller').map(b => b.key)).eql([
      'controllers.my-controller',
    ]);
    expect(ctx.find().map(b => b.key)).eql(['controllers.my-controller']);
  });

  it('allows binding attributes to be customized', () => {
    const ctx = new Context();
    discoveredClasses.forEach(c => {
      const binding = createBindingFromClass(c, {
        typeNamespaceMapping: {
          controller: 'controllers',
          service: 'service-proxies',
        },
      });
      ctx.add(binding);
    });
    expect(ctx.findByTag('provider').map(b => b.key)).eql(['my-date-provider']);
    expect(ctx.getBinding('service-proxies.MyService').scope).toEqual(
      BindingScope.SINGLETON,
    );
    expect(ctx.find().map(b => b.key)).eql([
      'service-proxies.MyService',
      'my-date-provider',
      'controllers.my-controller',
    ]);
  });

  it('supports default binding scope in options', () => {
    const binding = createBindingFromClass(MyController, {
      defaultScope: BindingScope.SINGLETON,
    });
    expect(binding.scope).toBe(BindingScope.SINGLETON);
  });

  describe('binding scope', () => {
    @injectable({
      // Explicitly set the binding scope to be `SINGLETON` as the developer
      // choose to implement the controller as a singleton without depending
      // on request specific information
      scope: BindingScope.SINGLETON,
    })
    class MySingletonController {}

    it('allows singleton controller with @injectable', () => {
      const binding = createBindingFromClass(MySingletonController, {
        type: 'controller',
      });
      expect(binding.key).toBe('controllers.MySingletonController');
      expect(binding.tagMap).toMatchObject({controller: 'controller'});
      expect(binding.scope).toBe(BindingScope.SINGLETON);
    });

    it('honors binding scope from @injectable over defaultScope', () => {
      const binding = createBindingFromClass(MySingletonController, {
        defaultScope: BindingScope.TRANSIENT,
      });
      expect(binding.scope).toBe(BindingScope.SINGLETON);
    });

    it('honors binding scope from @injectable', () => {
      const binding = createBindingFromClass(MySingletonController);
      expect(binding.scope).toBe(BindingScope.SINGLETON);
    });
  });
});
