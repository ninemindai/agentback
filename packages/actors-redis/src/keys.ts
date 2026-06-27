// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import type {RedisActorRuntimeOptions} from './redis-actor-runtime.js';

export const REDIS_ACTOR_CONNECTIONS =
  BindingKey.create<RedisConnectionManager>('actors.redis.connections');
export const REDIS_ACTOR_OPTIONS = BindingKey.create<RedisActorRuntimeOptions>(
  'actors.redis.options',
);
export const REDIS_ACTOR_OWNS_CONNECTIONS = BindingKey.create<boolean>(
  'actors.redis.ownsConnections',
);
