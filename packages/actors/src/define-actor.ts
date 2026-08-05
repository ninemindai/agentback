// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {DEFAULT_ACTOR_SEAT_CLASS, resolveDeadlineMs} from './deadlines.js';
import type {ActorDefinition, DefineActorOptions} from './types.js';

/**
 * Bind an actor type name to its Zod contracts and turn handler.
 *
 * The turn deadline is resolved here, once, so every runtime reads one number
 * off the definition instead of re-deriving the seat-class default: an
 * explicit `deadlineMs` wins, otherwise the seat class's band (capability 30s,
 * worker 10min).
 */
export function defineActor<S, C, R>(
  name: string,
  options: DefineActorOptions<S, C, R>,
): ActorDefinition<S, C, R> {
  if (!name.trim()) throw new Error('Actor name must not be empty.');
  const {seatClass = DEFAULT_ACTOR_SEAT_CLASS, deadlineMs, ...rest} = options;
  return {
    name,
    ...rest,
    seatClass,
    deadlineMs: resolveDeadlineMs({seatClass, deadlineMs}),
    __kind: 'actor',
  };
}
