// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';
import {
  Binding,
  BindingScope,
  BINDING_METADATA_KEY,
  Context,
  ContextEvent,
  ContextView,
  createBindingFromClass,
  Getter,
  injectable,
  MetadataInspector,
} from '@agentback/context';

import {types} from 'util';
import {
  addExtension,
  CoreTags,
  extensionFilter,
  extensionFor,
  extensionPoint,
  extensions,
} from '../../index.js';

describe('extension point', () => {
  describe('@extensionPoint', () => {
    it('specifies name of the extension point as a binding tag', () => {
      @extensionPoint('greeters', {scope: BindingScope.SINGLETON})
      class GreetingService {
        @extensions()
        public greeters: Getter<Greeter[]>;
      }

      const bindingMetadata = MetadataInspector.getClassMetadata(
        BINDING_METADATA_KEY,
        GreetingService,
      );

      expect(bindingMetadata).not.toBeUndefined();
      expect(bindingMetadata!.templates).toBeInstanceOf(Array);

      const binding = createBindingFromClass(GreetingService);
      expect(binding.tagMap).toMatchObject({
        [CoreTags.EXTENSION_POINT]: 'greeters',
      });
      expect(binding.scope).toEqual(BindingScope.SINGLETON);
    });
  });

  describe('@extensions', () => {
    let ctx: Context;

    beforeEach(givenContext);

    it('injects a getter function of extensions', async () => {
      @extensionPoint('greeters')
      class GreetingService {
        @extensions()
        public greeters: Getter<Greeter[]>;
      }

      // `@extensionPoint` is a sugar decorator for `@injectable`
      const binding = createBindingFromClass(GreetingService, {
        key: 'greeter-service',
      });
      ctx.add(binding);
      registerGreeters('greeters');
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      const greeters = await greeterService.greeters();
      assertGreeterExtensions(greeters);
    });

    it('injects a view of extensions', async () => {
      @extensionPoint('greeters')
      class GreetingService {
        readonly bindings: Set<Readonly<Binding<unknown>>>;
        constructor(
          @extensions.view()
          public readonly greetersView: ContextView<Greeter>,
        ) {
          this.bindings = new Set(this.greetersView.bindings);
          // Track bind events
          this.greetersView.on('bind', (event: ContextEvent) => {
            this.bindings.add(event.binding);
          });
          // Track unbind events
          this.greetersView.on('unbind', (event: ContextEvent) => {
            this.bindings.delete(event.binding);
          });
        }
      }

      // `@extensionPoint` is a sugar decorator for `@injectable`
      const binding = createBindingFromClass(GreetingService, {
        key: 'greeter-service',
      });
      ctx.add(binding);
      const registeredBindings = registerGreeters('greeters');
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      expect(Array.from(greeterService.bindings)).toEqual(registeredBindings);
      let greeters = await greeterService.greetersView.values();
      assertGreeterExtensions(greeters);
      expect(greeters.length).toBe(2);
      ctx.unbind(registeredBindings[0].key);
      greeters = await greeterService.greetersView.values();
      expect(greeters.length).toBe(1);
      expect(Array.from(greeterService.bindings)).toEqual([
        registeredBindings[1],
      ]);
    });

    it('injects a list of extensions', async () => {
      @extensionPoint('greeters')
      class GreetingService {
        @extensions.list()
        public greeters: Greeter[];
      }

      // `@extensionPoint` is a sugar decorator for `@injectable`
      const binding = createBindingFromClass(GreetingService, {
        key: 'greeter-service',
      });
      ctx.add(binding);
      const registeredBindings = registerGreeters('greeters');
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      expect(greeterService.greeters.length).toEqual(registeredBindings.length);
      assertGreeterExtensions(greeterService.greeters);

      const copy = Array.from(greeterService.greeters);
      // Now unbind the 1st greeter
      ctx.unbind(registeredBindings[0].key);
      // The injected greeters are not impacted
      expect(greeterService.greeters).toEqual(copy);
    });

    it('injects extensions based on `name` tag of the extension point binding', async () => {
      class GreetingService {
        @extensions()
        public greeters: Getter<Greeter[]>;
      }
      ctx
        .bind('greeter-service')
        .toClass(GreetingService)
        .tag({name: 'greeters'}); // Tag the extension point with a name
      registerGreeters('greeters');
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      const greeters = await greeterService.greeters();
      assertGreeterExtensions(greeters);
    });

    it('injects extensions based on class name of the extension point', async () => {
      class GreetingService {
        constructor(
          @extensions()
          public greeters: Getter<Greeter[]>,
        ) {}
      }
      ctx.bind('greeter-service').toClass(GreetingService);
      registerGreeters(GreetingService.name);
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      const loadedGreeters = await greeterService.greeters();
      assertGreeterExtensions(loadedGreeters);
    });

    it('injects extensions based on class name of the extension point using property', async () => {
      class GreetingService {
        @extensions()
        public greeters: Getter<Greeter[]>;
      }
      ctx.bind('greeter-service').toClass(GreetingService);
      registerGreeters(GreetingService.name);
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      const greeters = await greeterService.greeters();
      assertGreeterExtensions(greeters);
    });

    it('injects extensions based on extension point name from @extensions', async () => {
      class GreetingService {
        @extensions('greeters')
        public greeters: Getter<Greeter[]>;
      }
      ctx.bind('greeter-service').toClass(GreetingService);
      registerGreeters('greeters');
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      const greeters = await greeterService.greeters();
      assertGreeterExtensions(greeters);
    });

    it('injects extensions with metadata', async () => {
      class GreetingService {
        @extensions('greeters', {asProxyWithInterceptors: true})
        public greeters: Getter<Greeter[]>;
      }
      ctx.bind('greeter-service').toClass(GreetingService);
      registerGreeters('greeters');
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      const greeters = await greeterService.greeters();
      greeters.forEach(g => expect(types.isProxy(g)).toBe(true));
    });

    it('injects multiple types of extensions', async () => {
      interface Logger {
        log(message: string): void;
      }

      class ConsoleLogger implements Logger {
        log(message: string) {
          console.log(message);
        }
      }

      class GreetingService {
        constructor(
          @extensions('greeters')
          public greeters: Getter<Greeter[]>,
          @extensions('loggers')
          public loggers: Getter<Greeter[]>,
        ) {}
      }
      ctx.bind('greeter-service').toClass(GreetingService);
      registerGreeters('greeters');
      addExtension(ctx, 'loggers', ConsoleLogger);
      const greeterService = await ctx.get<GreetingService>('greeter-service');
      const loadedGreeters = await greeterService.greeters();
      assertGreeterExtensions(loadedGreeters);
      const loadedLoggers = await greeterService.loggers();
      expect(loadedLoggers).toBeInstanceOf(Array);
      expect(loadedLoggers.length).toBe(1);
      expect(loadedLoggers[0]).toBeInstanceOf(ConsoleLogger);
    });

    it('allows an extension to contribute to multiple extension points', () => {
      @injectable(
        extensionFor('extensionPoint-1'),
        extensionFor('extensionPoint-2'),
      )
      class MyExtension {}
      const binding = createBindingFromClass(MyExtension);
      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual([
        'extensionPoint-1',
        'extensionPoint-2',
      ]);
    });

    it('allows an extension of multiple extension points with extensionFor', () => {
      class MyExtension {}
      const binding = ctx.bind('my-extension').toClass(MyExtension);
      extensionFor('extensionPoint-1')(binding);
      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual(
        'extensionPoint-1',
      );

      // Now we have two extension points
      extensionFor('extensionPoint-2')(binding);
      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual([
        'extensionPoint-1',
        'extensionPoint-2',
      ]);

      // No duplication
      extensionFor('extensionPoint-1')(binding);
      expect(binding.tagMap[CoreTags.EXTENSION_FOR]).toEqual([
        'extensionPoint-1',
        'extensionPoint-2',
      ]);
    });

    it('allows multiple extension points for extensionFor', () => {
      class MyExtension {}
      const binding = ctx.bind('my-extension').toClass(MyExtension);
      extensionFor('extensionPoint-1', 'extensionPoint-2')(binding);
      expect(extensionFilter('extensionPoint-1')(binding)).toBe(true);
      expect(extensionFilter('extensionPoint-2')(binding)).toBe(true);
      expect(extensionFilter('extensionPoint-3')(binding)).toBe(false);
    });

    it('allows multiple extension points for extensionFilter', () => {
      class MyExtension {}
      const binding = ctx.bind('my-extension').toClass(MyExtension);
      extensionFor('extensionPoint-1', 'extensionPoint-2')(binding);
      expect(
        extensionFilter('extensionPoint-1', 'extensionPoint3')(binding),
      ).toBe(true);
      expect(
        extensionFilter('extensionPoint-2', 'extensionPoint3')(binding),
      ).toBe(true);
    });

    it('allows multiple extension points for @extensions', async () => {
      @extensionPoint('extensionPoint-1')
      class MyExtensionPoint1 {
        @extensions() getMyExtensions: Getter<MyExtension[]>;
      }

      @extensionPoint('extensionPoint-2')
      class MyExtensionPoint2 {
        @extensions() getMyExtensions: Getter<MyExtension[]>;
      }

      @injectable(extensionFor('extensionPoint-1', 'extensionPoint-2'))
      class MyExtension {}

      ctx.add(
        createBindingFromClass(MyExtensionPoint1, {key: 'extensionPoint1'}),
      );
      ctx.add(
        createBindingFromClass(MyExtensionPoint2, {key: 'extensionPoint2'}),
      );
      ctx.add(createBindingFromClass(MyExtension));
      const ep1: MyExtensionPoint1 = await ctx.get('extensionPoint1');
      const ep2: MyExtensionPoint2 = await ctx.get('extensionPoint2');
      const extensionsFor1 = await ep1.getMyExtensions();
      const extensionsFor2 = await ep2.getMyExtensions();
      expect(extensionsFor1.length).toEqual(1);
      expect(extensionsFor1[0]).toBeInstanceOf(MyExtension);
      expect(extensionsFor2.length).toEqual(1);
      expect(extensionsFor2[0]).toBeInstanceOf(MyExtension);
    });

    function givenContext() {
      ctx = new Context();
    }

    function registerGreeters(extensionPointName: string) {
      const g1 = addExtension(ctx, extensionPointName, EnglishGreeter, {
        namespace: 'greeters',
      });
      const g2 = addExtension(ctx, extensionPointName, ChineseGreeter, {
        namespace: 'greeters',
      });
      return [g1, g2];
    }
  });

  interface Greeter {
    language: string;
    greet(name: string): string;
  }

  class EnglishGreeter implements Greeter {
    language = 'en';
    greet(name: string) {
      return `Hello, ${name}!`;
    }
  }

  class ChineseGreeter implements Greeter {
    language = 'zh';
    greet(name: string) {
      return `你好，${name}！`;
    }
  }

  function assertGreeterExtensions(greeters: Greeter[]) {
    const languages = greeters.map(greeter => greeter.language).sort();
    expect(languages).toEqual(['en', 'zh']);
  }
});
