// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers, notifyLogHooksAlways} from '@agentback/common';
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
 * guard in process) *and* the elapsed time (`turnDeadlinePassed`) immediately
 * before the commit, with no suspension point in between.
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
 * Is this error **this** turn's own deadline?
 *
 * Classifying by type alone is not enough. An actor turn may invoke another
 * actor (`@injectActor` is a first-class shape), so a `TurnTimeoutError` raised
 * by an inner turn propagates out through the outer turn's `receive`. Recording
 * on type alone would append a *second* marker for the inner turn — to the
 * inner actor's journal, consuming another seq — from a runtime frame that
 * belongs to the outer one. A pass-through timeout is, to the outer turn, an
 * ordinary thrown turn: it rolls back and is not a deadline of its own.
 */
export function isOwnTurnTimeout(
  error: unknown,
  actor: ActorId,
  requestId: string,
): error is TurnTimeoutError {
  return (
    error instanceof TurnTimeoutError &&
    error.actor.type === actor.type &&
    error.actor.id === actor.id &&
    error.requestId === requestId
  );
}

/**
 * The half of "a timeout is a recorded failed turn" that every runtime emits,
 * under one namespace, so an operator sees the same line whichever adapter is
 * bound; a journaling runtime *additionally* appends an `actor.turn.timeout`
 * entry to the identity's log. It is the whole record on
 * `InMemoryActorRuntime`, which has no journal to append to.
 *
 * The **console** line is still gated on its debug namespace being enabled
 * (`agentback:actors:deadline:warn`) like every `loggers` call — nothing
 * about that changed. What is unconditional is delivery to a registered
 * `onLog` hook: `notifyLogHooksAlways` bypasses the namespace gate (see its
 * doc for why the gate would otherwise swallow the hook call too), so an
 * operator who wires a sink observes every timed-out turn on
 * `InMemoryActorRuntime` whether or not `DEBUG` happens to be set — which is
 * the case that matters here, since that runtime has no journal entry to
 * fall back on. Where the record must survive a process that never even
 * calls `onLog`, the journal entry on a journaling runtime is the one to
 * rely on.
 */
export function logTimedOutTurn(error: TurnTimeoutError): void {
  const args: [string, string, string, string, number] = [
    'Actor turn %s/%s (request %s) exceeded its %dms deadline. Nothing was committed and the seat is free; the abandoned turn keeps running but can no longer commit.',
    error.actor.type,
    error.actor.id,
    error.requestId,
    error.deadlineMs,
  ];
  log.warn(...args);
  notifyLogHooksAlways(log.warn, args);
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
  /**
   * `Date.now()` at the moment the deadline started — once the seat was free,
   * never when the call arrived. Read back at the commit boundary by
   * `turnDeadlinePassed`, which is the half of the check `expired` cannot
   * cover.
   */
  startedAt: number;
}

/**
 * Has this turn already spent its whole deadline? The **synchronous** half of
 * the deadline, and the reason it is a separate check from `TurnGuard.expired`.
 *
 * A JS timer cannot preempt synchronous CPU work, and microtasks drain before
 * macrotasks. So a `receive` that busy-spins past `deadlineMs` hands control
 * back through an already-settled promise, and the continuation — the guard
 * check and the commit — runs *before* the expired timer's callback ever
 * fires. `expired` is still `false` at that point, and the turn would commit
 * having plainly missed its deadline (on Redis it is worse: the renewal timers
 * did not fire either, so the lease lapses and the caller gets
 * `ActorLeaseLostError` with no timeout recorded anywhere).
 *
 * Reading the clock instead of a flag closes that, because elapsed time does
 * not depend on the event loop having had a turn. Every runtime therefore
 * tests both immediately before its commit, and treats either one as the same
 * expired turn: `TurnTimeoutError`, a recorded failed turn, rollback, seat
 * freed.
 */
export function turnDeadlinePassed(
  startedAt: number,
  deadlineMs: number,
): boolean {
  return Date.now() - startedAt > deadlineMs;
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
