// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, describe as context, expect} from 'vitest';
import {Constructor, inject, Provider} from '@agentback/context';

import {Application, Component, ControllerClass} from '../../index.js';

describe('Bootstrapping the application', () => {
  context('with user-defined components', () => {
    it('binds all user-defined components to the application context', () => {
      class AuditComponent {}
      const app = new Application();
      app.component(AuditComponent);
      const componentKeys = app.find('components.*').map(b => b.key);
      expect(componentKeys).toContainEqual('components.AuditComponent');

      const componentInstance = app.getSync('components.AuditComponent');
      expect(componentInstance).toBeInstanceOf(AuditComponent);
    });

    it('register all child components from a component', () => {
      let componentACreated = 0;
      class ComponentA implements Component {
        constructor() {
          componentACreated++;
        }
      }
      class ComponentB implements Component {}
      class ParentComponent implements Component {
        components = [ComponentA, ComponentB];
      }
      const app = new Application();
      app.component(ParentComponent);
      const componentKeys = app.find('components.*').map(b => b.key);
      expect(componentKeys).toContainEqual('components.ComponentA');
      expect(componentKeys).toContainEqual('components.ComponentB');
      expect(componentKeys).toContainEqual('components.ParentComponent');

      // Re-registration of ComponentA does not have side effects
      app.component(ComponentA);
      expect(componentACreated).toEqual(1);
    });

    it('registers all providers from components', () => {
      class FooProvider {
        value() {
          return 'bar';
        }
      }

      class FooComponent {
        providers = {foo: FooProvider};
      }
      const app = new Application();
      app.component(FooComponent);
      const value = app.getSync('foo');
      expect(value).toBe('bar');
    });

    it('registers all controllers from components', async () => {
      // TODO(bajtos) Beef up this test. Create a real controller with
      // a public API endpoint and verify that this endpoint can be invoked
      // via HTTP/REST API.

      class ProductController {}

      class ProductComponent {
        controllers: ControllerClass[] = [ProductController];
      }

      const app = new Application();
      app.component(ProductComponent);

      expect(app.find('controllers.*').map(b => b.key)).toEqual([
        'controllers.ProductController',
      ]);
    });

    it('allows parent context', async () => {
      class ProductController {}

      class ProductComponent {
        controllers: ControllerClass[] = [ProductController];
      }

      const parent = new Application();
      parent.component(ProductComponent);

      const app = new Application(parent);

      expect(app.find('controllers.*').map(b => b.key)).toEqual([
        'controllers.ProductController',
      ]);

      const app2 = new Application({}, parent);

      expect(app2.find('controllers.*').map(b => b.key)).toEqual([
        'controllers.ProductController',
      ]);

      const app3 = new Application();

      expect(app3.find('controllers.*').map(b => b.key)).not.toContainEqual([
        'controllers.ProductController',
      ]);
    });

    it('injects component dependencies', () => {
      class ConfigComponent {
        providers = {
          greetBriefly: class HelloProvider {
            value() {
              return true;
            }
          },
        };
      }

      class BriefGreetingProvider {
        value() {
          return 'Hi!';
        }
      }

      class LongGreetingProvider {
        value() {
          return 'Hello!';
        }
      }

      class GreetingComponent {
        providers: {
          greeting: Constructor<Provider<string>>;
        };

        constructor(@inject('greetBriefly') greetBriefly: boolean) {
          this.providers = {
            greeting: greetBriefly
              ? BriefGreetingProvider
              : LongGreetingProvider,
          };
        }
      }
      const app = new Application();
      app.component(ConfigComponent);
      app.component(GreetingComponent);

      expect(app.getSync('greeting')).toBe('Hi!');
    });
  });
});
