// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';
import {
  Binding,
  BindingScope,
  Context,
  ContextView,
  Getter,
  injectable,
} from '@agentback/context';

import {
  addExtension,
  CoreTags,
  extensionFilter,
  extensionFor,
  extensionPoint,
  extensions,
} from '../../index.js';

describe('Extension Point', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context('test-context');
  });

  describe('@extensionPoint decorator', () => {
    it('decorates a class as an extension point', () => {
      @extensionPoint('my-extension-point')
      class MyExtensionPoint {}

      ctx.bind('my.extension.point').toInjectable(MyExtensionPoint);
      const binding = ctx.getBinding('my.extension.point');
      expect(binding.tagMap[CoreTags.EXTENSION_POINT]).toBe(
        'my-extension-point',
      );
    });

    it('decorates a class with additional binding specs', () => {
      @extensionPoint('my-extension-point', {scope: BindingScope.SINGLETON})
      class MyExtensionPoint {}

      ctx.bind('my.extension.point').toInjectable(MyExtensionPoint);
      const binding = ctx.getBinding('my.extension.point');
      expect(binding.scope).toBe(BindingScope.SINGLETON);
      expect(binding.tagMap[CoreTags.EXTENSION_POINT]).toBe(
        'my-extension-point',
      );
    });

    it('decorates a class with multiple binding specs', () => {
      @extensionPoint(
        'my-extension-point',
        {scope: BindingScope.SINGLETON},
        {tags: ['custom-tag']},
      )
      class MyExtensionPoint {}

      ctx.bind('my.extension.point').toInjectable(MyExtensionPoint);
      const binding = ctx.getBinding('my.extension.point');
      expect(binding.scope).toBe(BindingScope.SINGLETON);
      expect(Array.from(binding.tagNames)).toContainEqual('custom-tag');
    });

    it('works with @injectable decorator', () => {
      @extensionPoint('my-extension-point')
      @injectable({scope: BindingScope.SINGLETON})
      class MyExtensionPoint {}

      ctx.bind('my.extension.point').toInjectable(MyExtensionPoint);
      const binding = ctx.getBinding('my.extension.point');
      expect(binding.scope).toBe(BindingScope.SINGLETON);
    });
  });

  describe('@extensions decorator', () => {
    it('injects a getter for extensions', async () => {
      interface Greeter {
        greet(): string;
      }

      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions()
          public getGreeters: Getter<Greeter[]>,
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toInjectable(GreetingService);
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      const greeters = await service.getGreeters();
      expect(greeters).toHaveLength(1);
      expect(greeters[0].greet()).toBe('Hello');
    });

    it('injects extensions with explicit extension point name', async () => {
      interface Greeter {
        greet(): string;
      }

      class GreetingService {
        constructor(
          @extensions('custom-greeters')
          public getGreeters: Getter<Greeter[]>,
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'custom-greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toClass(GreetingService);
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      const greeters = await service.getGreeters();
      expect(greeters).toHaveLength(1);
    });

    it('injects empty array when no extensions are registered', async () => {
      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions()
          public getGreeters: Getter<unknown[]>,
        ) {}
      }

      ctx.bind('greeting.service').toClass(GreetingService);

      const service = await ctx.get<GreetingService>('greeting.service');
      const greeters = await service.getGreeters();
      expect(greeters).toHaveLength(0);
    });

    it('injects multiple extensions', async () => {
      interface Greeter {
        greet(): string;
      }

      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions()
          public getGreeters: Getter<Greeter[]>,
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class SpanishGreeter implements Greeter {
        greet() {
          return 'Hola';
        }
      }

      ctx.bind('greeting.service').toInjectable(GreetingService);
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);
      ctx.bind('greeter.spanish').toInjectable(SpanishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      const greeters = await service.getGreeters();
      expect(greeters).toHaveLength(2);
    });
  });

  describe('@extensions.view decorator', () => {
    it('injects a ContextView for extensions', async () => {
      interface Greeter {
        greet(): string;
      }

      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions.view()
          public greetersView: ContextView<Greeter>,
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toInjectable(GreetingService);
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      expect(service.greetersView).toBeInstanceOf(ContextView);
      const greeters = await service.greetersView.values();
      expect(greeters).toHaveLength(1);
    });

    it('injects view with explicit extension point name', async () => {
      interface Greeter {
        greet(): string;
      }

      class GreetingService {
        constructor(
          @extensions.view('custom-greeters')
          public greetersView: ContextView<Greeter>,
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'custom-greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toClass(GreetingService);
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      const greeters = await service.greetersView.values();
      expect(greeters).toHaveLength(1);
    });

    it('view reflects dynamic changes to extensions', async () => {
      interface Greeter {
        greet(): string;
      }

      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions.view()
          public greetersView: ContextView<Greeter>,
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toInjectable(GreetingService);
      const service = await ctx.get<GreetingService>('greeting.service');

      let greeters = await service.greetersView.values();
      expect(greeters).toHaveLength(0);

      // Add extension dynamically
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);
      greeters = await service.greetersView.values();
      expect(greeters).toHaveLength(1);
    });
  });

  describe('@extensions.list decorator', () => {
    it('injects an array of resolved extension instances', async () => {
      interface Greeter {
        greet(): string;
      }

      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions.list()
          public greeters: Greeter[],
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toInjectable(GreetingService);
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      expect(service.greeters).toBeInstanceOf(Array);
      expect(service.greeters).toHaveLength(1);
      expect(service.greeters[0].greet()).toBe('Hello');
    });

    it('injects list with explicit extension point name', async () => {
      interface Greeter {
        greet(): string;
      }

      class GreetingService {
        constructor(
          @extensions.list('custom-greeters')
          public greeters: Greeter[],
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'custom-greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toClass(GreetingService);
      ctx.bind('greeter.english').toInjectable(EnglishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      expect(service.greeters).toHaveLength(1);
    });

    it('injects empty array when no extensions are registered', async () => {
      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions.list()
          public greeters: unknown[],
        ) {}
      }

      ctx.bind('greeting.service').toClass(GreetingService);

      const service = await ctx.get<GreetingService>('greeting.service');
      expect(service.greeters).toHaveLength(0);
    });

    it('list is a snapshot and does not reflect dynamic changes', async () => {
      interface Greeter {
        greet(): string;
      }

      @extensionPoint('greeters')
      class GreetingService {
        constructor(
          @extensions.list()
          public greeters: Greeter[],
        ) {}
      }

      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class EnglishGreeter implements Greeter {
        greet() {
          return 'Hello';
        }
      }

      ctx.bind('greeting.service').toClass(GreetingService);
      ctx.bind('greeter.english').toClass(EnglishGreeter);

      const service = await ctx.get<GreetingService>('greeting.service');
      const initialLength = service.greeters.length;

      // Add another extension
      @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
      class SpanishGreeter implements Greeter {
        greet() {
          return 'Hola';
        }
      }
      ctx.bind('greeter.spanish').toClass(SpanishGreeter);

      // The injected list should not change
      expect(service.greeters).toHaveLength(initialLength);
    });
  });

  describe('extensionFilter', () => {
    it('creates a filter for single extension point', () => {
      const filter = extensionFilter('my-extension-point');

      const binding1 = Binding.bind('ext1')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: 'my-extension-point',
        });
      const binding2 = Binding.bind('ext2')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: 'other-extension-point',
        });

      expect(filter(binding1)).toBe(true);
      expect(filter(binding2)).toBe(false);
    });

    it('creates a filter for multiple extension points', () => {
      const filter = extensionFilter('point-a', 'point-b');

      const binding1 = Binding.bind('ext1')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: 'point-a',
        });
      const binding2 = Binding.bind('ext2')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: 'point-b',
        });
      const binding3 = Binding.bind('ext3')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: 'point-c',
        });

      expect(filter(binding1)).toBe(true);
      expect(filter(binding2)).toBe(true);
      expect(filter(binding3)).toBe(false);
    });

    it('handles bindings with array of extension points', () => {
      const filter = extensionFilter('point-a');

      const binding = Binding.bind('ext1')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: ['point-a', 'point-b'],
        });

      expect(filter(binding)).toBe(true);
    });

    it('returns false for bindings without extension tag', () => {
      const filter = extensionFilter('my-extension-point');
      const binding = Binding.bind('ext1').to({});

      expect(filter(binding)).toBe(false);
    });
  });

  describe('extensionFor', () => {
    it('creates a binding template for single extension point', () => {
      const template = extensionFor('my-extension-point');
      const binding = Binding.bind('ext1').to({});

      template(binding);

      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toBe('my-extension-point');
    });

    it('creates a binding template for multiple extension points', () => {
      const template = extensionFor('point-a', 'point-b');
      const binding = Binding.bind('ext1').to({});

      template(binding);

      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual([
        'point-a',
        'point-b',
      ]);
    });

    it('appends to existing extension points', () => {
      const binding = Binding.bind('ext1')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: 'point-a',
        });

      const template = extensionFor('point-b');
      template(binding);

      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual([
        'point-a',
        'point-b',
      ]);
    });

    it('does not duplicate extension points', () => {
      const binding = Binding.bind('ext1')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: 'point-a',
        });

      const template = extensionFor('point-a', 'point-b');
      template(binding);

      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual([
        'point-a',
        'point-b',
      ]);
    });

    it('handles empty extension point names', () => {
      const template = extensionFor();
      const binding = Binding.bind('ext1').to({});

      template(binding);

      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toBeUndefined();
    });

    it('normalizes single extension point to string', () => {
      const template = extensionFor('point-a');
      const binding = Binding.bind('ext1').to({});

      template(binding);

      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toBe('point-a');
    });

    it('handles array of existing extension points', () => {
      const binding = Binding.bind('ext1')
        .to({})
        .tag({
          [CoreTags.EXTENSION_FOR]: ['point-a', 'point-b'],
        });

      const template = extensionFor('point-c');
      template(binding);

      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual([
        'point-a',
        'point-b',
        'point-c',
      ]);
    });
  });

  describe('addExtension', () => {
    it('adds an extension to the context', () => {
      @injectable()
      class MyExtension {
        value = 'extension';
      }

      const binding = addExtension(ctx, 'my-extension-point', MyExtension);

      expect(binding).toBeInstanceOf(Binding);
      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toBe('my-extension-point');
      expect(ctx.contains(binding.key)).toBe(true);
    });

    it('adds extension with custom options', () => {
      @injectable()
      class MyExtension {
        value = 'extension';
      }

      const binding = addExtension(ctx, 'my-extension-point', MyExtension, {
        name: 'custom-name',
        namespace: 'extensions',
      });

      expect(binding.key).toBe('extensions.custom-name');
    });

    it('returns the created binding', () => {
      @injectable()
      class MyExtension {}

      const binding = addExtension(ctx, 'my-extension-point', MyExtension);

      expect(binding).toBeInstanceOf(Binding);
      expect(binding.valueConstructor).toBe(MyExtension);
    });
  });

  describe('Integration scenarios', () => {
    it('extension contributing to multiple extension points', () => {
      @injectable()
      class MultiExtension {}

      const binding = Binding.bind('multi.ext')
        .toClass(MultiExtension)
        .apply(extensionFor('point-a', 'point-b'));

      ctx.add(binding);

      const filterA = extensionFilter('point-a');
      const filterB = extensionFilter('point-b');

      expect(filterA(binding)).toBe(true);
      expect(filterB(binding)).toBe(true);
    });
  });
});

// Made with Bob
