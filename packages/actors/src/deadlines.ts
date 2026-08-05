// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {ActorEvent, ActorId} from './types.js';

const log = loggers('agentback:actors:deadline');

/**
 * The deadline band an actor's turns run under.
 *
 * A **capability** seat answers a caller who is waiting — a REST request, an
 * MCP tool call, an agent turn — so its deadline is measured in seconds. A
 * **worker** seat does back-office work nobody is blocked on (a batch, an
 * import, a long tool chain), so its deadline is measured in minutes. The
 * class is the coarse choice; `deadlineMs` on the definition is the fine one
 * and always wins.
 */
export type ActorSeatClass = 'capability' | 'worker';

/** Seat class an actor definition gets when it declares none. */
export const DEFAULT_ACTOR_SEAT_CLASS: ActorSeatClass = 'capability';

/** Per-turn deadline each seat class gets when the definition sets none. */
export const SEAT_CLASS_DEADLINE_MS: Readonly<Record<ActorSeatClass, number>> =
  {
    capability: 30_000,
    worker: 600_000,
  };

/**
 * Reserved event type of the failed-turn record a journaling runtime appends
 * when a turn misses its deadline. The `actor.` prefix is reserved for
 * runtime-authored records; a domain event must not use it. A journal consumer
 * that only cares about domain facts filters on it — but it is in the log on
 * purpose, because "a timeout is a recorded failed turn" is only true if the
 * record is where the turns are.
 */
export const ACTOR_TURN_TIMEOUT_EVENT = 'actor.turn.timeout';

/**
 * A turn did not finish inside its seat type's deadline. The turn is
 * **abandoned, not cancelled** — nothing interrupts a `receive` that is still
 * running — but it can no longer commit: every runtime re-checks its
 * mutual-exclusion guard (the lease token on Redis, the equivalent per-turn
 * guard in process) immediately before the commit, with no suspension point
 * in between.
 */
export class TurnTimeoutError extends Error {
  readonly code = 'actor_turn_timeout';
  constructor(
    readonly actor: ActorId,
    readonly requestId: string,
    readonly deadlineMs: number,
  ) {
    super(
      `Actor turn for '${actor.type}/${actor.id}' (request '${requestId}') exceeded its ${deadlineMs}ms deadline.`,
    );
    this.name = 'TurnTimeoutError';
  }
}

/**
 * The deadline one definition runs under: an explicit `deadlineMs` if it
 * declares one, otherwise its seat class's default.
 */
export function resolveDeadlineMs(options: {
  seatClass?: ActorSeatClass;
  deadlineMs?: number;
}): number {
  const {deadlineMs} = options;
  if (deadlineMs === undefined) {
    return SEAT_CLASS_DEADLINE_MS[
      options.seatClass ?? DEFAULT_ACTOR_SEAT_CLASS
    ];
  }
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error('deadlineMs must be a positive finite number.');
  }
  return deadlineMs;
}

/** The journal record a runtime appends for a turn that missed its deadline. */
export function turnTimeoutEvent(deadlineMs: number): ActorEvent {
  return {type: ACTOR_TURN_TIMEOUT_EVENT, deadlineMs};
}

/**
 * The always-present half of "a timeout is a recorded failed turn". Every
 * runtime emits it under one namespace so an operator sees the same line
 * whichever adapter is bound; a journaling runtime *additionally* appends an
 * `actor.turn.timeout` entry to the identity's log. It is the whole record on
 * `InMemoryActorRuntime`, which has no journal to append to.
 */
export function logTimedOutTurn(error: TurnTimeoutError): void {
  log.warn(
    'Actor turn %s/%s (request %s) exceeded its %dms deadline. Nothing was committed and the seat is free; the abandoned turn keeps running but can no longer commit.',
    error.actor.type,
    error.actor.id,
    error.requestId,
    error.deadlineMs,
  );
}

/**
 * Per-turn expiry flag: the in-process counterpart of the Redis lease token.
 * A runtime that enforces the deadline in process hands one to its turn and
 * re-reads it immediately before committing, so an abandoned turn that
 * eventually resolves cannot overwrite the state a later turn already
 * committed.
 */
export interface TurnGuard {
  expired: boolean;
}

/**
 * Reject with `TurnTimeoutError` if `work` has not settled within `deadlineMs`.
 *
 * `Promise.race` subscribes to `work`, so a rejection that arrives after the
 * deadline already settled the race is handled (and discarded) rather than
 * surfacing as an unhandled rejection — which is what lets an abandoned turn
 * throw on its own guard check without crashing the process.
 */
export function raceTurnDeadline<T>(
  work: Promise<T>,
  actor: ActorId,
  requestId: string,
  deadlineMs: number,
  guard?: TurnGuard,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      if (guard) guard.expired = true;
      reject(new TurnTimeoutError(actor, requestId, deadlineMs));
    }, deadlineMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
