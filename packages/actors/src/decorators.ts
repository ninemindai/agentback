// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  BindingScope,
  extensionFor,
  injectable,
  type TagMap,
} from '@agentback/core';
import {
  ClassDecoratorFactory,
  MethodDecoratorFactory,
} from '@agentback/metadata';
import type {ZodType} from 'zod';
import {
  ACTOR_EXTENSIONS,
  ActorMetadata,
  type ActorClassMetadata,
  type ActorCommandMetadata,
  type ActorQueryMetadata,
} from './keys.js';

export interface ActorOptions<S> {
  state: ZodType<S>;
  scope?: BindingScope;
  tags?: TagMap;
}

/**
 * Mark a stateless service class as an actor behavior contributor. Register the
 * class with `app.service()` so the actor registry can discover it.
 */
export function actor<S>(
  name: string,
  options: ActorOptions<S>,
): ClassDecorator {
  if (!name.trim()) throw new Error('Actor name must not be empty.');
  const metadata: ActorClassMetadata = {
    name,
    state: options.state as ZodType<unknown>,
  };
  const markClass = ClassDecoratorFactory.createDecorator<ActorClassMetadata>(
    ActorMetadata.CLASS,
    metadata,
    {decoratorName: '@actor'},
  );
  const markBinding = injectable(
    {
      scope: options.scope ?? BindingScope.SINGLETON,
      tags: options.tags,
    },
    extensionFor(ACTOR_EXTENSIONS),
  );
  return target => {
    markClass(target);
    markBinding(target);
  };
}

export interface ActorCommandOptions<I, O> {
  input: ZodType<I>;
  output: ZodType<O>;
}

/** Mark a service method as one typed actor command handler. */
export function actorCommand<I, O>(
  name: string,
  options: ActorCommandOptions<I, O>,
): MethodDecorator {
  if (!name.trim()) throw new Error('Actor command name must not be empty.');
  return (target, methodName, descriptor) => {
    const metadata: ActorCommandMetadata = {
      name,
      input: options.input as ZodType<unknown>,
      output: options.output as ZodType<unknown>,
      methodName,
    };
    MethodDecoratorFactory.createDecorator<ActorCommandMetadata>(
      ActorMetadata.COMMAND,
      metadata,
      {decoratorName: '@actorCommand'},
    )(target, methodName, descriptor);
  };
}

export interface ActorQueryOptions<I, O> {
  input: ZodType<I>;
  output: ZodType<O>;
}

/**
 * Mark a service method as one typed actor query — a **read-only** operation
 * `(state, input, ctx) => result`. Queries take no turn and no mailbox/lease, so
 * they run concurrently with commands and other queries against a state
 * snapshot. They must not mutate the state they receive.
 */
export function actorQuery<I, O>(
  name: string,
  options: ActorQueryOptions<I, O>,
): MethodDecorator {
  if (!name.trim()) throw new Error('Actor query name must not be empty.');
  return (target, methodName, descriptor) => {
    const metadata: ActorQueryMetadata = {
      name,
      input: options.input as ZodType<unknown>,
      output: options.output as ZodType<unknown>,
      methodName,
    };
    MethodDecoratorFactory.createDecorator<ActorQueryMetadata>(
      ActorMetadata.QUERY,
      metadata,
      {decoratorName: '@actorQuery'},
    )(target, methodName, descriptor);
  };
}
