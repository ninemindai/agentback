// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Binding,
  BoundValue,
  Constructor,
  createBindingFromClass,
  Provider,
} from '@agentback/context';
import {
  Application,
  ControllerClass,
  ServiceOrProviderClass,
} from './application.js';
import {CoreTags} from './keys.js';
import {LifeCycleObserver} from './lifecycle.js';
import {Server} from './server.js';

/**
 * A map of provider classes to be bound to a context
 */
export interface ProviderMap {
  [key: string]: Constructor<Provider<BoundValue>>;
}

/**
 * A map of classes to be bound to a context
 */
export interface ClassMap {
  [key: string]: Constructor<BoundValue>;
}

/**
 * A component declares a set of artifacts so that they can be contributed to
 * an application as a group
 */
export interface Component {
  /**
   * An array of controller classes
   */
  controllers?: ControllerClass[];

  /**
   * A map of providers to be bound to the application context
   *
   * @example
   * ```ts
   * {
   *   'authentication.strategies.ldap': LdapStrategyProvider
   * }
   * ```
   */
  providers?: ProviderMap;

  /**
   * A map of classes to be bound to the application context.
   *
   * @example
   * ```ts
   * {
   *   'rest.body-parsers.xml': XmlBodyParser
   * }
   * ```
   */
  classes?: ClassMap;

  /**
   * A map of name/class pairs for servers
   */
  servers?: {
    [name: string]: Constructor<Server>;
  };

  lifeCycleObservers?: Constructor<LifeCycleObserver>[];

  /**
   * An array of service or provider classes
   */
  services?: ServiceOrProviderClass[];

  /**
   * An array of bindings to be aded to the application context.
   *
   * @example
   * ```ts
   * const bindingX = Binding.bind('x').to('Value X');
   * this.bindings = [bindingX]
   * ```
   */
  bindings?: Binding[];

  /**
   * An array of component classes
   */
  components?: Constructor<Component>[];

  /**
   * Other properties
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [prop: string]: any;
}

/**
 * Mount a component to an Application.
 *
 * @param app - Application
 * @param component - Component instance
 * @param componentKey - Binding key of the component being mounted; every
 * binding the component contributes is tagged `fromComponent` with this value so
 * provenance is recorded without resolving the component. Defaults to the
 * component's class name when not supplied.
 */
export function mountComponent(
  app: Application,
  component: Component,
  componentKey?: string,
) {
  const owner = componentKey ?? component.constructor?.name;
  // Provenance is last-wins: if a binding is contributed by more than one
  // component the most recent owner is kept (which also matches the surviving
  // binding when a key is re-registered).
  const fromComponent = <T>(binding: Binding<T>): Binding<T> =>
    owner ? binding.tag({[CoreTags.FROM_COMPONENT]: owner}) : binding;

  if (component.classes) {
    for (const classKey in component.classes) {
      const binding = createBindingFromClass(component.classes[classKey], {
        key: classKey,
      });
      fromComponent(binding);
      app.add(binding);
    }
  }

  if (component.providers) {
    for (const providerKey in component.providers) {
      const binding = createBindingFromClass(component.providers[providerKey], {
        key: providerKey,
      });
      fromComponent(binding);
      app.add(binding);
    }
  }

  if (component.bindings) {
    for (const binding of component.bindings) {
      fromComponent(binding);
      app.add(binding);
    }
  }

  // A class listed in both `controllers` and `services` is contributed once, as
  // a single binding (see the `services` loop below) — unlike two explicit
  // `app.controller()` + `app.service()` calls, which deliberately keep separate
  // bindings. Registering once also applies the class's `extensionFor` template
  // a single time, so its extension-point names stay deduped.
  const serviceClasses = new Set<Function>();
  for (const s of component.services ?? []) {
    if (typeof s === 'function') serviceClasses.add(s);
  }

  if (component.controllers) {
    for (const controllerCtor of component.controllers) {
      if (serviceClasses.has(controllerCtor)) continue;
      fromComponent(app.controller(controllerCtor));
    }
  }

  if (component.servers) {
    for (const serverKey in component.servers) {
      fromComponent(app.server(component.servers[serverKey], serverKey));
    }
  }

  if (component.lifeCycleObservers) {
    for (const observer of component.lifeCycleObservers) {
      fromComponent(app.lifeCycleObserver(observer));
    }
  }

  if (component.services) {
    const controllerClasses = new Set<Function>(component.controllers ?? []);
    for (const service of component.services) {
      const binding = fromComponent(app.service(service));
      // Dual-surface class (in both arrays): tag the same binding as a
      // controller too, so the component yields one binding rather than two.
      if (typeof service === 'function' && controllerClasses.has(service)) {
        binding.tag(CoreTags.CONTROLLER);
      }
    }
  }

  if (component.components) {
    for (const c of component.components) {
      if (c === component) continue;
      fromComponent(app.component(c));
    }
  }
}
