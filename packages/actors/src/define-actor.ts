// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {DEFAULT_ACTOR_SEAT_CLASS, resolveDeadlineMs} from './deadlines.js';
import {assertActorIdentityPart} from './types.js';
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
  // The actor type half of the identity check every runtime applies to the id
  // (see `assertActorIdentityPart`): a type is fixed at definition time, so
  // this is where it is validated once, for every runtime.
  assertActorIdentityPart('type', name);
  const {seatClass = DEFAULT_ACTOR_SEAT_CLASS, deadlineMs, ...rest} = options;
  return {
    name,
    ...rest,
    seatClass,
    deadlineMs: resolveDeadlineMs({seatClass, deadlineMs}),
    __kind: 'actor',
  };
}
