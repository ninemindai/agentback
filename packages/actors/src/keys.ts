// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import {MetadataAccessor} from '@agentback/metadata';
import type {ZodType} from 'zod';
import type {ActorRegistry} from './registry.js';
import type {ActorRuntime} from './types.js';

export const ACTOR_RUNTIME = BindingKey.create<ActorRuntime>('actors.runtime');
export const ACTOR_REGISTRY =
  BindingKey.create<ActorRegistry>('actors.registry');

/** Extension point for service classes marked with `@actor()`. */
export const ACTOR_EXTENSIONS = 'actors.extensions';

export interface ActorClassMetadata {
  name: string;
  state: ZodType<unknown>;
}

export interface ActorCommandMetadata {
  name: string;
  input: ZodType<unknown>;
  output: ZodType<unknown>;
  methodName: string | symbol;
}

export namespace ActorMetadata {
  export const CLASS = MetadataAccessor.create<
    ActorClassMetadata,
    ClassDecorator
  >('actors:class');
  export const COMMAND = MetadataAccessor.create<
    ActorCommandMetadata,
    MethodDecorator
  >('actors:command');
}
