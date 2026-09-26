// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {Fetch} from '@agentback/common';
import {
  Application,
  ApplicationConfig,
  ApplicationMetadata,
  ControllerClass,
} from './application.js';
import {
  LifeCycleObserverOptions,
  LifeCycleObserverRegistry,
} from './lifecycle-registry.js';

/**
 * Namespace for core binding keys
 */
export namespace CoreBindings {
  // application
  /**
   * Binding key for application instance itself
   */
  export const APPLICATION_INSTANCE = BindingKey.create<Application>(
    'application.instance',
  );

  /**
   * Binding key for application configuration
   */
  export const APPLICATION_CONFIG: BindingKey<ApplicationConfig> =
    BindingKey.create<ApplicationConfig>('application.config');

  /**
   * Binding key for the content of `package.json`
   */
  export const APPLICATION_METADATA = BindingKey.create<ApplicationMetadata>(
    'application.metadata',
  );

  /**
   * Binding key for the injectable HTTP {@link Fetch} seam. Domain services
   * that call an external API should inject this (optional, defaulting to
   * `globalThis.fetch`) instead of the global, so tests can bind a stub:
   *
   * ```ts
   * constructor(
   *   @inject(CoreBindings.FETCH, {optional: true})
   *   private readonly fetch: Fetch = globalThis.fetch,
   * ) {}
   * ```
   */
  export const FETCH = BindingKey.create<Fetch>('application.fetch');

  /**
   * Binding key for the in-flight unit of work's {@link AbortSignal} — the
   * neutral "stop doing this now" seam. Bound into the per-invocation context
   * by every entry point that owns a cancellable unit of work (a REST request,
   * an MCP tool call, an agent turn), and aborted when the caller goes away or
   * a deadline elapses. A queue job is the exception: its signal is the
   * `JobContext.signal` field, not a binding.
   *
   * Inject it (always optionally — a plain service call has no ambient unit of
   * work) and hand it to whatever actually spends time or money:
   *
   * ```ts
   * async forecast(
   *   input: Input,
   *   @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
   * ) {
   *   const res = await this.fetch(url, {signal});   // stop paying on hangup
   * }
   * ```
   *
   * The reason is a `DOMException` named `AbortError` carrying one of
   * `AbortReasons` (`@agentback/common`), so `fetch` and the AI SDK rethrow it
   * unchanged and `isAbortError()` recognizes it downstream.
   */
  export const ABORT_SIGNAL = BindingKey.create<AbortSignal>(
    'application.abortSignal',
  );

  // server
  /**
   * Binding key for servers
   */
  export const SERVERS = 'servers';

  // component
  /**
   * Binding key for components
   */
  export const COMPONENTS = 'components';

  // controller
  export const CONTROLLERS = 'controllers';

  /**
   * Binding key for the controller class resolved in the current request
   * context
   */
  export const CONTROLLER_CLASS: BindingKey<ControllerClass> =
    BindingKey.create<ControllerClass>('controller.current.ctor');

  /**
   * Binding key for the controller method resolved in the current request
   * context
   */
  export const CONTROLLER_METHOD_NAME = BindingKey.create<string>(
    'controller.current.operation',
  );

  /**
   * Binding key for the controller method metadata resolved in the current
   * request context
   */
  export const CONTROLLER_METHOD_META = 'controller.method.meta';

  /**
   * Binding key for the controller instance resolved in the current request
   * context
   */
  export const CONTROLLER_CURRENT = BindingKey.create('controller.current');

  export const LIFE_CYCLE_OBSERVERS = 'lifeCycleObservers';
  /**
   * Binding key for life cycle observer options
   */
  export const LIFE_CYCLE_OBSERVER_REGISTRY =
    BindingKey.create<LifeCycleObserverRegistry>('lifeCycleObserver.registry');

  /**
   * Binding key for life cycle observer options
   */
  export const LIFE_CYCLE_OBSERVER_OPTIONS =
    BindingKey.create<LifeCycleObserverOptions>('lifeCycleObserver.options');
}

export namespace CoreTags {
  /**
   * Binding tag for components
   */
  export const COMPONENT = 'component';

  /**
   * Provenance tag recording the component a binding came from. The value is
   * the contributing component's binding key. Set by `mountComponent`.
   */
  export const FROM_COMPONENT = 'fromComponent';

  /**
   * Binding tag for servers
   */
  export const SERVER = 'server';

  /**
   * Binding tag for controllers
   */
  export const CONTROLLER = 'controller';

  /**
   * Binding tag for services
   */
  export const SERVICE = 'service';
  /**
   * Binding tag for the service interface
   */
  export const SERVICE_INTERFACE = 'serviceInterface';

  /**
   * Binding tag for life cycle observers
   */
  export const LIFE_CYCLE_OBSERVER = 'lifeCycleObserver';

  /**
   * Binding tag for group name of life cycle observers
   */
  export const LIFE_CYCLE_OBSERVER_GROUP = 'lifeCycleObserverGroup';

  /**
   * Binding tag for extensions to specify name of the extension point that an
   * extension contributes to.
   */
  export const EXTENSION_FOR = 'extensionFor';

  /**
   * Binding tag for an extension point to specify name of the extension point
   */
  export const EXTENSION_POINT = 'extensionPoint';
}
