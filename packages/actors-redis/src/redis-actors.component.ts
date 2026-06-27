// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ActorRegistry} from '@agentback/actors';
import {
  Application,
  Binding,
  BindingScope,
  ContextTags,
  inject,
  lifeCycleObserver,
  mountComponent,
  type Component,
  type LifeCycleObserver,
} from '@agentback/core';
import {
  RedisConnectionManager,
  type BullMQConnectionConfig,
} from '@agentback/messaging-bullmq';
import {
  REDIS_ACTOR_CONNECTIONS,
  REDIS_ACTOR_OPTIONS,
  REDIS_ACTOR_OWNS_CONNECTIONS,
} from './keys.js';
import {
  RedisActorRuntime,
  type RedisActorRuntimeOptions,
} from './redis-actor-runtime.js';

export const REDIS_ACTORS_OBSERVER_KEY = 'observers.RedisActors';

export interface RedisActorsComponentOptions extends RedisActorRuntimeOptions {
  /** Share an existing manager, for example BullMQMessagingComponent.connections. */
  connections?: RedisConnectionManager;
  /** Create and own a manager when `connections` is omitted. */
  connection?: BullMQConnectionConfig;
}

@lifeCycleObserver('00-actors-redis', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: REDIS_ACTORS_OBSERVER_KEY},
})
export class RedisActorsLifecycleObserver implements LifeCycleObserver {
  constructor(
    @inject(REDIS_ACTOR_CONNECTIONS)
    private readonly connections: RedisConnectionManager,
    @inject(REDIS_ACTOR_OWNS_CONNECTIONS)
    private readonly ownsConnections: boolean,
  ) {}

  async stop(): Promise<void> {
    if (this.ownsConnections) await this.connections.close();
  }
}

/** Redis runtime, registry, configuration bindings, and connection lifecycle. */
export class RedisActorsComponent implements Component {
  readonly connections: RedisConnectionManager;
  readonly bindings: Binding[];
  readonly services = [
    RedisActorRuntime,
    ActorRegistry,
    RedisActorsLifecycleObserver,
  ];

  constructor(options: RedisActorsComponentOptions = {}) {
    const {connections, connection, ...runtimeOptions} = options;
    this.connections = connections ?? new RedisConnectionManager(connection);
    this.bindings = [
      Binding.bind(REDIS_ACTOR_CONNECTIONS).to(this.connections),
      Binding.bind(REDIS_ACTOR_OPTIONS).to(runtimeOptions),
      Binding.bind(REDIS_ACTOR_OWNS_CONNECTIONS).to(connections === undefined),
    ];
  }
}

/** Mount an option-bearing RedisActorsComponent instance onto an application. */
export function installRedisActors(
  app: Application,
  options: RedisActorsComponentOptions = {},
): RedisActorsComponent {
  const component = new RedisActorsComponent(options);
  mountComponent(app, component, 'components.RedisActorsComponent');
  return component;
}
