// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {
  BindingScope,
  Constructor,
  Context,
  createBindingFromClass,
  inject,
  injectable,
} from '@agentback/context';

import {
  Application,
  Component,
  CoreBindings,
  CoreTags,
  LifeCycleObserver,
  lifeCycleObserver,
  Server,
} from '../../index.js';

describe('Application life cycle', () => {
  describe('state', () => {
    it('updates application state', async () => {
      const app = new Application();
      expect(app.state).toBe('created');
      const initialize = app.init();
      expect(app.state).toBe('initializing');
      await initialize;
      expect(app.state).toBe('initialized');
      const start = app.start();
      await start;
      expect(app.state).toBe('started');
      const stop = app.stop();
      expect(app.state).toBe('stopping');
      await stop;
      expect(app.state).toBe('stopped');
    });

    it('calls init by start only once', async () => {
      const app = new Application();
      let start = app.start();
      expect(app.state).toBe('initializing');
      await start;
      expect(app.state).toBe('started');
      const stop = app.stop();
      expect(app.state).toBe('stopping');
      await stop;
      expect(app.state).toBe('stopped');
      start = app.start();
      expect(app.state).toBe('starting');
      await start;
      expect(app.state).toBe('started');
      await app.stop();
    });

    it('emits state change events', async () => {
      const app = new Application();
      const events: string[] = [];
      app.on('stateChanged', event => {
        events.push(`${event.from} -> ${event.to}`);
      });
      const start = app.start();
      expect(events).toEqual(['created -> initializing']);
      await start;
      expect(events).toEqual([
        'created -> initializing',
        'initializing -> initialized',
        'initialized -> starting',
        'starting -> started',
      ]);
      const stop = app.stop();
      expect(events).toEqual([
        'created -> initializing',
        'initializing -> initialized',
        'initialized -> starting',
        'starting -> started',
        'started -> stopping',
      ]);
      await stop;
      expect(events).toEqual([
        'created -> initializing',
        'initializing -> initialized',
        'initialized -> starting',
        'starting -> started',
        'started -> stopping',
        'stopping -> stopped',
      ]);
    });

    it('emits state events', async () => {
      const app = new Application();
      const events: string[] = [];
      for (const e of [
        'initializing',
        'initialized',
        'starting',
        'started',
        'stopping',
        'stopped',
      ]) {
        app.on(e, event => {
          events.push(e);
        });
      }
      const start = app.start();
      expect(events).toEqual(['initializing']);
      await start;
      expect(events).toEqual([
        'initializing',
        'initialized',
        'starting',
        'started',
      ]);
      const stop = app.stop();
      expect(events).toEqual([
        'initializing',
        'initialized',
        'starting',
        'started',
        'stopping',
      ]);
      await stop;
      expect(events).toEqual([
        'initializing',
        'initialized',
        'starting',
        'started',
        'stopping',
        'stopped',
      ]);
    });

    it('allows application.stop when it is created', async () => {
      const app = new Application();
      await app.stop(); // no-op
      expect(app.state).toBe('created');
    });

    it('allows application.stop when it is initialized', async () => {
      const app = new Application();
      await app.init();
      expect(app.state).toBe('initialized');
      await app.stop();
      expect(app.state).toBe('stopped');
    });

    it('await application.stop when it is stopping', async () => {
      const app = new Application();
      await app.start();
      const stop = app.stop();
      const stopAgain = app.stop();
      await stop;
      await stopAgain;
      expect(app.state).toBe('stopped');
    });

    it('await application.start when it is starting', async () => {
      const app = new Application();
      const start = app.start();
      const startAgain = app.start();
      await start;
      await startAgain;
      expect(app.state).toBe('started');
    });
  });

  describe('start', () => {
    it('starts all injected servers', async () => {
      const app = new Application();
      app.component(ObservingComponentWithServers);
      const component = await app.get<ObservingComponentWithServers>(
        `${CoreBindings.COMPONENTS}.ObservingComponentWithServers`,
      );
      expect(component.status).toBe('not-initialized');
      await app.start();
      const server = await app.getServer(ObservingServer);

      expect(server).not.toBeNull();
      expect(server.listening).toBe(true);
      expect(component.status).toBe('started');
      await app.stop();
    });

    it('starts servers bound with `LIFE_CYCLE_OBSERVER` tag', async () => {
      const app = new Application();
      app
        .bind('fake-server')
        .toClass(ObservingServer)
        .tag(CoreTags.LIFE_CYCLE_OBSERVER, CoreTags.SERVER)
        .inScope(BindingScope.SINGLETON);
      await app.start();
      const server = await app.get<ObservingServer>('fake-server');

      expect(server).not.toBeNull();
      expect(server.listening).toBe(true);
      await app.stop();
    });

    it('starts/stops all registered components', async () => {
      const app = new Application();
      app.component(ObservingComponentWithServers);
      const component = await app.get<ObservingComponentWithServers>(
        `${CoreBindings.COMPONENTS}.ObservingComponentWithServers`,
      );
      expect(component.status).toBe('not-initialized');
      await app.start();
      expect(component.status).toBe('started');
      await app.stop();
      expect(component.status).toBe('stopped');
    });

    it('initializes all registered components', async () => {
      const app = new Application();
      app.component(ObservingComponentWithServers);
      const component = await app.get<ObservingComponentWithServers>(
        `${CoreBindings.COMPONENTS}.ObservingComponentWithServers`,
      );
      expect(component.status).toBe('not-initialized');
      await app.init();
      expect(component.status).toBe('initialized');
      expect(component.initialized).toBe(true);
    });

    it('initializes all registered components by start', async () => {
      const app = new Application();
      app.component(ObservingComponentWithServers);
      const component = await app.get<ObservingComponentWithServers>(
        `${CoreBindings.COMPONENTS}.ObservingComponentWithServers`,
      );
      expect(component.status).toBe('not-initialized');
      await app.start();
      expect(component.status).toBe('started');
      expect(component.initialized).toBe(true);
    });

    it('starts/stops all observers from the component', async () => {
      const app = new Application();
      app.component(ComponentWithObservers);
      const observer = await app.get<MyObserver>(
        'lifeCycleObservers.MyObserver',
      );
      const observerWithDecorator = await app.get<MyObserverWithDecorator>(
        'lifeCycleObservers.MyObserverWithDecorator',
      );
      expect(observer.status).toBe('not-initialized');
      expect(observerWithDecorator.status).toBe('not-initialized');
      await app.start();
      expect(observer.status).toBe('started');
      expect(observerWithDecorator.status).toBe('started');
      await app.stop();
      expect(observer.status).toBe('stopped');
      expect(observerWithDecorator.status).toBe('stopped');
    });

    it('starts/stops all registered life cycle observers', async () => {
      const app = new Application();
      app.lifeCycleObserver(MyObserver, 'my-observer');

      const observer = await app.get<MyObserver>(
        'lifeCycleObservers.my-observer',
      );
      expect(observer.status).toBe('not-initialized');
      await app.start();
      expect(observer.status).toBe('started');
      await app.stop();
      expect(observer.status).toBe('stopped');
    });

    it('starts/stops all registered life cycle observers with param injections', async () => {
      const app = new Application();
      app.lifeCycleObserver(MyObserverWithMethodInjection, 'my-observer');

      const observer = await app.get<MyObserverWithMethodInjection>(
        'lifeCycleObservers.my-observer',
      );
      app.bind('prefix').to('***');
      expect(observer.status).toBe('not-initialized');
      await app.init();
      expect(observer.status).toBe('***:initialized');
      await app.start();
      expect(observer.status).toBe('***:started');
      app.bind('prefix').to('###');
      await app.stop();
      expect(observer.status).toBe('###:stopped');
    });

    it('registers life cycle observers with options', async () => {
      const app = new Application();
      const binding = app.lifeCycleObserver(MyObserver, {
        name: 'my-observer',
        namespace: 'my-observers',
      });
      expect(binding.key).toEqual('my-observers.my-observer');
    });

    it('honors @injectable', async () => {
      @injectable({
        tags: {
          [CoreTags.LIFE_CYCLE_OBSERVER]: CoreTags.LIFE_CYCLE_OBSERVER,
          [CoreTags.LIFE_CYCLE_OBSERVER_GROUP]: 'my-group',
          namespace: CoreBindings.LIFE_CYCLE_OBSERVERS,
        },
        scope: BindingScope.SINGLETON,
      })
      class MyObserverWithBind implements LifeCycleObserver {
        status = 'not-initialized';

        start() {
          this.status = 'started';
        }
        stop() {
          this.status = 'stopped';
        }
      }

      const app = new Application();
      const binding = createBindingFromClass(MyObserverWithBind);
      app.add(binding);
      expect(binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]).toEqual(
        'my-group',
      );

      const observer = await app.get<MyObserverWithBind>(binding.key);
      expect(observer.status).toBe('not-initialized');
      await app.start();
      expect(observer.status).toBe('started');
      await app.stop();
      expect(observer.status).toBe('stopped');
    });

    it('honors @lifeCycleObserver', async () => {
      const app = new Application();
      const binding = createBindingFromClass(MyObserverWithDecorator);
      app.add(binding);
      expect(binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP]).toEqual(
        'my-group',
      );
      expect(binding.scope).toEqual(BindingScope.SINGLETON);

      const observer = await app.get<MyObserverWithDecorator>(binding.key);
      expect(observer.status).toBe('not-initialized');
      await app.start();
      expect(observer.status).toBe('started');
      await app.stop();
      expect(observer.status).toBe('stopped');
    });

    it('does not attempt to start poorly named bindings', async () => {
      const app = new Application();
      let startInvoked = false;
      let stopInvoked = false;

      // The app.start should not attempt to start this binding.
      app.bind('controllers.servers').to({
        start: () => {
          startInvoked = true;
        },
        stop: () => {
          stopInvoked = true;
        },
      });
      await app.start();
      expect(startInvoked).toBe(false); // not invoked
      await app.stop();
      expect(stopInvoked).toBe(false); // not invoked
    });
  });

  describe('app.onInit()', () => {
    it('registers the handler as "init" lifecycle observer', async () => {
      const app = new Application();
      let invoked = false;

      const binding = app.onInit(async function doSomething() {
        // delay the actual observer code to the next tick to
        // verify that the promise returned by an async observer
        // is correctly forwarded by LifeCycle wrapper
        await Promise.resolve();
        invoked = true;
      });

      expect(binding.key).toMatch(/^lifeCycleObservers.doSomething/);

      await app.start();
      expect(invoked).toBe(true);
    });

    it('registers multiple handlers with the same name', async () => {
      const app = new Application();
      const invoked: string[] = [];

      app.onInit(() => {
        invoked.push('first');
      });
      app.onInit(() => {
        invoked.push('second');
      });

      await app.init();
      expect(invoked).toEqual(['first', 'second']);
    });
  });

  describe('app.onStart()', () => {
    it('registers the handler as "start" lifecycle observer', async () => {
      const app = new Application();
      let invoked = false;

      const binding = app.onStart(async function doSomething() {
        // delay the actual observer code to the next tick to
        // verify that the promise returned by an async observer
        // is correctly forwarded by LifeCycle wrapper
        await Promise.resolve();
        invoked = true;
      });

      expect(binding.key).toMatch(/^lifeCycleObservers.doSomething/);

      await app.start();
      expect(invoked).toBe(true);
    });

    it('registers multiple handlers with the same name', async () => {
      const app = new Application();
      const invoked: string[] = [];

      app.onStart(() => {
        invoked.push('first');
      });
      app.onStart(() => {
        invoked.push('second');
      });

      await app.start();
      expect(invoked).toEqual(['first', 'second']);
    });
  });

  describe('app.onStop()', () => {
    it('registers the handler as "stop" lifecycle observer', async () => {
      const app = new Application();
      let invoked = false;

      const binding = app.onStop(async function doSomething() {
        // delay the actual observer code to the next tick to
        // verify that the promise returned by an async observer
        // is correctly forwarded by LifeCycle wrapper
        await Promise.resolve();
        invoked = true;
      });

      expect(binding.key).toMatch(/^lifeCycleObservers.doSomething/);

      await app.start();
      expect(invoked).toBe(false);
      await app.stop();
      expect(invoked).toBe(true);
    });

    it('registers multiple handlers with the same name', async () => {
      const app = new Application();
      const invoked: string[] = [];
      app.onStop(() => {
        invoked.push('first');
      });
      app.onStop(() => {
        invoked.push('second');
      });
      await app.start();
      expect(invoked).toHaveLength(0);
      await app.stop();
      // `stop` observers are invoked in reverse order
      expect(invoked).toEqual(['second', 'first']);
    });
  });
});

class ObservingComponentWithServers implements Component, LifeCycleObserver {
  status = 'not-initialized';
  initialized = false;

  servers: {
    [name: string]: Constructor<Server>;
  };
  constructor() {
    this.servers = {
      ObservingServer: ObservingServer,
      ObservingServer2: ObservingServer,
    };
  }

  init() {
    this.status = 'initialized';
    this.initialized = true;
  }
  start() {
    this.status = 'started';
  }
  stop() {
    this.status = 'stopped';
  }
}

class ObservingServer extends Context implements Server {
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

class MyObserver implements LifeCycleObserver {
  status = 'not-initialized';

  start() {
    this.status = 'started';
  }
  stop() {
    this.status = 'stopped';
  }
}

class MyObserverWithMethodInjection implements LifeCycleObserver {
  status = 'not-initialized';

  init(@inject('prefix') prefix: string) {
    this.status = `${prefix}:initialized`;
  }

  start(@inject('prefix') prefix: string) {
    this.status = `${prefix}:started`;
  }

  stop(@inject('prefix') prefix: string) {
    this.status = `${prefix}:stopped`;
  }
}

@lifeCycleObserver('my-group', {scope: BindingScope.SINGLETON})
class MyObserverWithDecorator implements LifeCycleObserver {
  status = 'not-initialized';

  start() {
    this.status = 'started';
  }
  stop() {
    this.status = 'stopped';
  }
}

class ComponentWithObservers implements Component {
  lifeCycleObservers = [MyObserver, MyObserverWithDecorator];
}
