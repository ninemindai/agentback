// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ActorDefinition, DefineActorOptions} from './types.js';

/** Bind an actor type name to its Zod contracts and turn handler. */
export function defineActor<S, C, R>(
  name: string,
  options: DefineActorOptions<S, C, R>,
): ActorDefinition<S, C, R> {
  if (!name.trim()) throw new Error('Actor name must not be empty.');
  return {name, ...options, __kind: 'actor'};
}
