// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, afterEach, expect} from 'vitest';
import {
  asGlobalInterceptor,
  Binding,
  BindingScope,
  BindingTag,
  Context,
  ContextTags,
  getBindingMetadata,
  inject,
  injectable,
  Interceptor,
  InvocationContext,
  Next,
  Provider,
} from '@agentback/context';

import {
  Application,
  Component,
  CoreBindings,
  CoreTags,
  Server,
} from '../../index.js';

describe('Application', () => {
  let app: Application;

  afterEach(() => app.stop());

  describe('app bindings', () => {
    it('binds the application itself', () => {
      app = new Application();
      expect(app.getSync(CoreBindings.APPLICATION_INSTANCE)).toBe(app);
    });

    it('binds the application config', () => {
      const myAppConfig = {name: 'my-app', port: 3000};
      app = new Application(myAppConfig);
      expect(app.getSync(CoreBindings.APPLICATION_CONFIG)).toBe(myAppConfig);
    });

    it('configures the application', () => {
      const myAppConfig = {name: 'my-app', port: 3000};
      app = new Application(myAppConfig);
      expect(app.getConfigSync(CoreBindings.APPLICATION_INSTANCE)).toBe(
        myAppConfig,
      );
    });
  });

  describe('controller binding', () => {
    beforeEach(givenApp);

    class MyController {}

    it('binds a controller', () => {
      const binding = app.controller(MyController);
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.CONTROLLER);
      expect(binding.key).toBe('controllers.MyController');
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
      expect(findKeysByTag(app, CoreTags.CONTROLLER)).toContainEqual(
        binding.key,
      );
    });

    it('binds a controller with custom name', () => {
      const binding = app.controller(MyController, 'my-controller');
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.CONTROLLER);
      expect(binding.key).toBe('controllers.my-controller');
      expect(findKeysByTag(app, CoreTags.CONTROLLER)).toContainEqual(
        binding.key,
      );
    });

    it('binds a controller with custom options', () => {
      const binding = app.controller(MyController, {
        name: 'my-controller',
        namespace: 'my-controllers',
      });
      expect(binding.key).toEqual('my-controllers.my-controller');
    });

    it('binds a singleton controller', () => {
      @injectable({scope: BindingScope.SINGLETON})
      class MySingletonController {}

      const binding = app.controller(MySingletonController);
      expect(binding.scope).toBe(BindingScope.SINGLETON);
      expect(findKeysByTag(app, 'controller')).toContainEqual(binding.key);
    });
  });

  describe('component binding', () => {
    beforeEach(givenApp);

    class MyComponent implements Component {}

    it('binds a component', () => {
      const binding = app.component(MyComponent);
      expect(binding.scope).toBe(BindingScope.SINGLETON);
      expect(findKeysByTag(app, CoreTags.COMPONENT)).toContainEqual(
        'components.MyComponent',
      );
    });

    it('binds a component with custom name', () => {
      app.component(MyComponent, 'my-component');
      expect(findKeysByTag(app, CoreTags.COMPONENT)).toContainEqual(
        'components.my-component',
      );
    });

    it('binds a component with custom namespace', () => {
      const binding = app.component(MyComponent, {
        name: 'my-component',
        namespace: 'my-components',
      });
      expect(binding.key).toEqual('my-components.my-component');
    });

    it('binds a transient component', () => {
      @injectable({scope: BindingScope.TRANSIENT})
      class MyTransientComponent {}

      const binding = app.component(MyTransientComponent);
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
    });

    it('binds controllers from a component', () => {
      class MyController {}

      class MyComponentWithControllers implements Component {
        controllers = [MyController];
      }

      app.component(MyComponentWithControllers);
      expect(app.getBinding('controllers.MyController').valueConstructor).toBe(
        MyController,
      );
    });

    it('binds bindings from a component', () => {
      const binding = Binding.bind('foo');
      class MyComponentWithBindings implements Component {
        bindings = [binding];
      }

      app.component(MyComponentWithBindings);
      expect(app.getBinding('foo')).toBe(binding);
    });

    it('binds classes from a component', () => {
      class MyClass {}

      class MyComponentWithClasses implements Component {
        classes = {'my-class': MyClass};
      }

      app.component(MyComponentWithClasses);
      expect(app.contains('my-class')).toBe(true);
      expect(app.getBinding('my-class').valueConstructor).toBe(MyClass);
      expect(app.getSync('my-class')).toBeInstanceOf(MyClass);
    });

    it('binds providers from a component', () => {
      class MyProvider implements Provider<string> {
        value() {
          return 'my-str';
        }
      }

      class MyComponentWithProviders implements Component {
        providers = {'my-provider': MyProvider};
      }

      app.component(MyComponentWithProviders);
      expect(app.contains('my-provider')).toBe(true);
      expect(app.getSync('my-provider')).toEqual('my-str');
    });

    it('binds classes with @injectable from a component', () => {
      @injectable({scope: BindingScope.SINGLETON, tags: ['foo']})
      class MyClass {}

      class MyComponentWithClasses implements Component {
        classes = {'my-class': MyClass};
      }

      app.component(MyComponentWithClasses);
      const binding = app.getBinding('my-class');
      expect(binding.scope).toEqual(BindingScope.SINGLETON);
      expect(binding.tagNames).toContainEqual('foo');
    });

    it('binds services from a component', () => {
      class MyService {}

      class MyComponentWithServices implements Component {
        services = [MyService];
      }

      app.component(MyComponentWithServices);

      expect(app.getBinding('services.MyService').valueConstructor).toBe(
        MyService,
      );
    });

    it('binds services with @injectable from a component', () => {
      @injectable({scope: BindingScope.TRANSIENT, tags: ['foo']})
      class MyService {}

      class MyComponentWithServices implements Component {
        services = [MyService];
      }

      app.component(MyComponentWithServices);

      const binding = app.getBinding('services.MyService');
      expect(binding.scope).toEqual(BindingScope.TRANSIENT);
      expect(binding.tagNames).toContainEqual('foo');
    });

    it('honors tags when binding providers from a component', () => {
      @injectable({tags: ['foo']})
      class MyProvider implements Provider<string> {
        value() {
          return 'my-str';
        }
      }

      class MyComponentWithProviders implements Component {
        providers = {'my-provider': MyProvider};
      }

      app.component(MyComponentWithProviders);
      const binding = app.getBinding('my-provider');
      expect(binding.tagNames).toContainEqual('foo');
    });

    it('binds from a component constructor', () => {
      class MyComponentWithDI implements Component {
        constructor(@inject(CoreBindings.APPLICATION_INSTANCE) ctx: Context) {
          // Programmatically bind to the context
          ctx.bind('foo').to('bar');
        }
      }

      app.component(MyComponentWithDI);
      expect(app.contains('foo')).toBe(true);
      expect(app.getSync('foo')).toEqual('bar');
    });
  });

  describe('server binding', () => {
    beforeEach(givenApp);

    it('defaults to constructor name', async () => {
      const binding = app.server(FakeServer);
      expect(binding.scope).toBe(BindingScope.SINGLETON);
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVER);
      const result = await app.getServer(FakeServer.name);
      expect(result.constructor.name).toBe(FakeServer.name);
    });

    it('binds a server with a different scope than SINGLETON', async () => {
      @injectable({scope: BindingScope.TRANSIENT})
      class TransientServer extends FakeServer {}

      const binding = app.server(TransientServer);
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
    });

    it('allows custom name', async () => {
      const name = 'customName';
      app.server(FakeServer, name);
      const result = await app.getServer(name);
      expect(result.constructor.name).toBe(FakeServer.name);
    });

    it('allows custom namespace', async () => {
      const name = 'customName';
      const binding = app.server(FakeServer, {name, namespace: 'my-servers'});
      expect(binding.key).toEqual('my-servers.customName');
    });

    it('allows binding of multiple servers as an array', async () => {
      const bindings = app.servers([FakeServer, AnotherServer]);
      expect(Array.from(bindings[0].tagNames)).toContainEqual(CoreTags.SERVER);
      expect(Array.from(bindings[1].tagNames)).toContainEqual(CoreTags.SERVER);
      const fakeResult = await app.getServer(FakeServer);
      expect(fakeResult.constructor.name).toBe(FakeServer.name);
      const AnotherResult = await app.getServer(AnotherServer);
      expect(AnotherResult.constructor.name).toBe(AnotherServer.name);
    });
  });

  describe('service binding', () => {
    beforeEach(givenApp);

    class MyService {}

    it('binds a service', () => {
      const binding = app.service(MyService);
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVICE);
      expect(binding.key).toBe('services.MyService');
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
      expect(findKeysByTag(app, CoreTags.SERVICE)).toContainEqual(binding.key);
    });

    it('binds a service with custom name', () => {
      const binding = app.service(MyService, 'my-service');
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVICE);
      expect(binding.key).toBe('services.my-service');
      expect(findKeysByTag(app, CoreTags.SERVICE)).toContainEqual(binding.key);
    });

    it('binds a service with custom namespace', () => {
      const binding = app.service(MyService, {
        namespace: 'my-services',
        name: 'my-service',
      });
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVICE);
      expect(binding.key).toBe('my-services.my-service');
      expect(findKeysByTag(app, CoreTags.SERVICE)).toContainEqual(binding.key);
    });

    it('binds a service with custom interface - string', () => {
      const binding = app.service(MyService, {interface: 'MyService'});
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVICE);
      expect(binding.tagMap[CoreTags.SERVICE_INTERFACE]).toEqual('MyService');
    });

    it('binds a service with custom interface - symbol', () => {
      const MyServiceInterface = Symbol('MyService');
      const binding = app.service(MyService, {interface: MyServiceInterface});
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVICE);
      expect(binding.tagMap[CoreTags.SERVICE_INTERFACE]).toEqual(
        MyServiceInterface,
      );
    });

    it('binds a singleton service', () => {
      @injectable({scope: BindingScope.SINGLETON})
      class MySingletonService {}

      const binding = app.service(MySingletonService);
      expect(binding.scope).toBe(BindingScope.SINGLETON);
      expect(findKeysByTag(app, 'service')).toContainEqual(binding.key);
    });

    it('binds a service provider', () => {
      @injectable({tags: {date: 'now', namespace: 'localServices'}})
      class MyServiceProvider implements Provider<Date> {
        value() {
          return new Date();
        }
      }

      const binding = app.service(MyServiceProvider);
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVICE);
      expect(binding.tagMap.date).toEqual('now');
      expect(binding.key).toBe('localServices.MyService');
      expect(binding.scope).toBe(BindingScope.TRANSIENT);
      expect(findKeysByTag(app, 'service')).toContainEqual(binding.key);
    });

    it('binds a service provider with name tag', () => {
      @injectable({tags: {date: 'now', name: 'my-service'}})
      class MyServiceProvider implements Provider<Date> {
        value() {
          return new Date();
        }
      }

      const binding = app.service(MyServiceProvider);
      expect(Array.from(binding.tagNames)).toContainEqual(CoreTags.SERVICE);
      expect(binding.tagMap.date).toEqual('now');
      expect(binding.key).toBe('services.my-service');
      expect(findKeysByTag(app, 'service')).toContainEqual(binding.key);
    });

    it('binds subclasses of a service without mutating base class', () => {
      @injectable({scope: BindingScope.SINGLETON})
      class BaseService {}

      class SubService extends BaseService {}

      const templates = getBindingMetadata(BaseService)?.templates;

      app.service(BaseService, {
        defaultScope: BindingScope.SINGLETON,
      });
      app.service(SubService, {
        defaultScope: BindingScope.SINGLETON,
      });
      expect(getBindingMetadata(BaseService)?.templates?.length).toBe(
        templates?.length,
      );
    });
  });

  describe('shutdown signal listener', () => {
    beforeEach(givenApp);

    it('registers a SIGTERM listener when app starts', async () => {
      const count = getListeners().length;
      await app.start();
      expect(getListeners().length).toEqual(count + 1);
    });

    it('does not impact SIGTERM listener when app stops without start', async () => {
      const count = getListeners().length;
      await app.stop();
      expect(getListeners().length).toEqual(count);
    });

    it('registers/removes a SIGTERM listener by start/stop', async () => {
      await app.start();
      const count = getListeners().length;
      await app.stop();
      expect(getListeners().length).toEqual(count - 1);
      // Restart
      await app.start();
      expect(getListeners().length).toEqual(count);
    });

    it('does not register a SIGTERM listener when app is created', async () => {
      const count = getListeners().length;
      // Create another application
      new Application();
      expect(getListeners().length).toEqual(count);
    });

    function getListeners() {
      return process.listeners('SIGTERM');
    }
  });

  describe('interceptor binding', () => {
    beforeEach(givenApp);

    it('registers a function as local interceptor', () => {
      const binding = app.interceptor(logInterceptor, {
        name: 'logInterceptor',
      });
      expect(binding).toMatchObject({
        key: 'interceptors.logInterceptor',
      });
      expect(binding.tagMap[ContextTags.GLOBAL_INTERCEPTOR]).toBeUndefined();
    });

    it('registers a provider class as local interceptor', () => {
      const binding = app.interceptor(LogInterceptorProviderWithoutDecoration, {
        name: 'logInterceptor',
      });
      expect(binding).toMatchObject({
        key: 'interceptors.logInterceptor',
      });
      expect(binding.tagMap[ContextTags.GLOBAL_INTERCEPTOR]).toBeUndefined();
    });

    it('registers a function as global interceptor', () => {
      const binding = app.interceptor(logInterceptor, {
        global: true,
        group: 'log',
        source: ['route', 'proxy'],
        name: 'logInterceptor',
      });
      expect(binding).toMatchObject({
        key: 'globalInterceptors.logInterceptor',
        tagMap: {
          [ContextTags.GLOBAL_INTERCEPTOR_GROUP]: 'log',
          [ContextTags.GLOBAL_INTERCEPTOR_SOURCE]: ['route', 'proxy'],
          [ContextTags.GLOBAL_INTERCEPTOR]: ContextTags.GLOBAL_INTERCEPTOR,
        },
      });
    });

    it('registers a provider class as global interceptor', () => {
      const binding = app.interceptor(LogInterceptorProvider, {
        group: 'log',
        source: ['route', 'proxy'],
        name: 'logInterceptor',
      });
      expect(binding).toMatchObject({
        key: 'globalInterceptors.logInterceptor',
        tagMap: {
          [ContextTags.GLOBAL_INTERCEPTOR_GROUP]: 'log',
          [ContextTags.GLOBAL_INTERCEPTOR_SOURCE]: ['route', 'proxy'],
          [ContextTags.GLOBAL_INTERCEPTOR]: ContextTags.GLOBAL_INTERCEPTOR,
        },
      });
    });

    it('registers a provider class without decoration as global interceptor', () => {
      const binding = app.interceptor(LogInterceptorProviderWithoutDecoration, {
        global: true,
        group: 'log',
        source: ['route', 'proxy'],
        name: 'logInterceptor',
      });
      expect(binding).toMatchObject({
        key: 'globalInterceptors.logInterceptor',
        tagMap: {
          [ContextTags.GLOBAL_INTERCEPTOR_GROUP]: 'log',
          [ContextTags.GLOBAL_INTERCEPTOR_SOURCE]: ['route', 'proxy'],
          [ContextTags.GLOBAL_INTERCEPTOR]: ContextTags.GLOBAL_INTERCEPTOR,
        },
      });
    });

    function logInterceptor(ctx: InvocationContext, next: Next) {
      return undefined;
    }

    @injectable(asGlobalInterceptor())
    class LogInterceptorProvider implements Provider<Interceptor> {
      value() {
        return logInterceptor;
      }
    }

    class LogInterceptorProviderWithoutDecoration implements Provider<Interceptor> {
      value() {
        return logInterceptor;
      }
    }
  });

  function findKeysByTag(ctx: Context, tag: BindingTag | RegExp) {
    return ctx.findByTag(tag).map(binding => binding.key);
  }

  function givenApp() {
    app = new Application();
  }
});

describe('Application constructor', () => {
  it('accepts config and parent context', () => {
    const ctx = new Context();
    const app = new Application({name: 'my-app'}, ctx);
    expect(app.parent).toEqual(ctx);
    expect(app.options).toEqual({name: 'my-app'});
  });

  it('accepts parent context without config', () => {
    const ctx = new Context();
    const app = new Application(ctx);
    expect(app.parent).toEqual(ctx);
  });

  it('uses application name as the context name', () => {
    const app = new Application({name: 'my-app'});
    expect(app.name).toEqual('my-app');
  });

  it('uses Application-<uuid> as the context name', () => {
    const app = new Application();
    expect(app.name).toMatch(/Application-/);
  });
});

class FakeServer extends Context implements Server {
  listening = false;
  constructor() {
    super();
  }
  async start(): Promise<void> {
    this.listening = true;
  }

  async stop(): Promise<void> {
    this.listening = false;
  }
}

class AnotherServer extends FakeServer {}
