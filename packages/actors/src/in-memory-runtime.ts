// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope, ContextTags, injectable} from '@agentback/core';
import {
  isOwnTurnTimeout,
  logTimedOutTurn,
  raceTurnDeadline,
  turnDeadlinePassed,
  TurnTimeoutError,
  type TurnGuard,
} from './deadlines.js';
import {ACTOR_RUNTIME} from './keys.js';
import {assertActorIdentityPart} from './types.js';
import type {
  ActorDefinition,
  ActorEvent,
  ActorId,
  ActorInvokeOptions,
  ActorRef,
  ActorRuntime,
} from './types.js';

interface StoredActor {
  state: unknown;
  results: Map<string, {commandFingerprint: string; result: unknown}>;
}

function actorKey(actor: ActorId): string {
  return `${actor.type}\u0000${actor.id}`;
}

/** Stable JSON fingerprint shared by ActorRuntime adapters. */
export function actorCommandFingerprint(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean'
    ) {
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new Error('Actor commands must contain only finite numbers.');
      }
      return item;
    }
    if (Array.isArray(item)) return item.map(canonicalize);
    if (typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Actor commands must be JSON-serializable objects.');
      }
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    throw new Error('Actor commands must be JSON-serializable.');
  };
  return JSON.stringify(canonicalize(value));
}

/**
 * A turn's `events` failed to commit because one value inside them is not
 * plain, finite JSON. `path` names the exact offending location (e.g.
 * `events[0].when`), the way a schema validation error would.
 */
export class NonJsonEventValueError extends Error {
  readonly code = 'actor_event_not_json_portable';
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`Actor event value at '${path}' is not JSON-portable: ${reason}.`);
    this.name = 'NonJsonEventValueError';
  }
}

/**
 * Comfortably above any sane event payload. `turn.events` is bug- or
 * attacker-controlled (a caller-supplied command can shape what a `receive`
 * emits), and the walk below recurses once per nesting level, so without a
 * cap a deeply-nested-enough event would blow the stack on every commit path,
 * on all three runtimes alike — worse than the value it exists to reject,
 * since a `RangeError` here carries no offending path at all. Same posture as
 * the pre-existing, unguarded `actorCommandFingerprint` canonicalizer above
 * (and `defineActor`'s command-side walk it shares the shape with) — not
 * touched here, out of this change's scope, but worth the same fix later.
 */
const MAX_EVENT_JSON_DEPTH = 64;

function assertJsonValue(value: unknown, path: string, depth = 0): void {
  if (depth > MAX_EVENT_JSON_DEPTH) {
    throw new NonJsonEventValueError(
      path,
      `nesting exceeds the ${MAX_EVENT_JSON_DEPTH}-level limit`,
    );
  }
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (Number.isFinite(value as number)) return;
    throw new NonJsonEventValueError(
      path,
      `${String(value)} is not a finite number`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonValue(item, `${path}[${index}]`, depth + 1),
    );
    return;
  }
  if (type === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const name = (value as object).constructor?.name ?? 'object';
      throw new NonJsonEventValueError(
        path,
        `is a ${name}, not a plain object`,
      );
    }
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      assertJsonValue(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  // undefined, function, bigint, symbol.
  throw new NonJsonEventValueError(
    path,
    type === 'undefined' ? 'is undefined' : `is a ${type}`,
  );
}

/**
 * Validate that every event a turn is about to commit is plain, finite JSON.
 * The two journaling adapters persist `turn.events` two different ways —
 * `EventSourcedActorRuntime` via `structuredClone`, `RedisActorRuntime` via
 * `JSON.stringify` — and a value that survives one but not the other
 * (`undefined`, `NaN`/`Infinity`, a `Date`, a `BigInt`, a non-plain object)
 * would silently diverge: preserved in process, dropped or coerced on Redis.
 * Called at the same point in every `ActorRuntime` adapter's commit path,
 * including `InMemoryActorRuntime`, which keeps no journal and so never
 * persists the value it rejects — an app first exercised in dev against the
 * journal-free runtime must still fail loudly, before it ever depends on
 * behavior a journaling adapter cannot reproduce.
 */
export function assertJsonPortableEvents(
  events: readonly ActorEvent[] | undefined,
): void {
  if (!events) return;
  events.forEach((event, index) => assertJsonValue(event, `events[${index}]`));
}

export interface InMemoryActorRuntimeOptions {
  /**
   * Max committed request results retained per actor for idempotent replay.
   * The map is bounded FIFO: once full, the oldest entry is evicted, so
   * replaying a since-evicted requestId re-runs the command. Default 1024.
   */
  dedupLimit?: number;
}

/**
 * Single-process reference adapter for tests and design validation.
 *
 * The commit of state + request result is synchronous and occurs only after a
 * successful, schema-valid turn. This models the transaction a durable adapter
 * must provide, but does not make user side effects transactional.
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_RUNTIME.key},
})
export class InMemoryActorRuntime implements ActorRuntime {
  private readonly definitions = new Map<string, object>();
  private readonly actors = new Map<string, StoredActor>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly dedupLimit: number;

  constructor(options: InMemoryActorRuntimeOptions = {}) {
    const limit = options.dedupLimit ?? 1024;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('dedupLimit must be a positive integer.');
    }
    this.dedupLimit = limit;
  }

  register<S, C, R>(definition: ActorDefinition<S, C, R>): void {
    const existing = this.definitions.get(definition.name);
    if (existing && existing !== definition) {
      throw new Error(`Actor type '${definition.name}' is already registered.`);
    }
    this.definitions.set(definition.name, definition);
  }

  ref<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    id: string,
  ): ActorRef<C, R> {
    this.assertRegistered(definition);
    assertActorIdentityPart('id', id);
    const actor = {type: definition.name, id};
    return {
      actor,
      invoke: (command, options) =>
        this.invoke(definition, actor, command, options),
    };
  }

  async state<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    id: string,
  ): Promise<S> {
    this.assertRegistered(definition);
    assertActorIdentityPart('id', id);
    // Reads take no mailbox slot: commit reassigns `stored.state` atomically, so
    // a lone read observes either the pre- or post-commit value (never torn) and
    // runs concurrently with turns and other reads. An absent actor returns its
    // computed initial state without storing it (a read must not mutate).
    const stored = this.actors.get(actorKey({type: definition.name, id}));
    if (!stored) {
      return structuredClone(
        definition.state.parse(await definition.initialState(id)),
      ) as S;
    }
    return structuredClone(stored.state) as S;
  }

  private async invoke<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    actor: ActorId,
    command: C,
    options: ActorInvokeOptions = {},
  ): Promise<R> {
    const parsedCommand = definition.command.parse(command);
    const fingerprint = actorCommandFingerprint(parsedCommand);
    const requestId = options.requestId ?? crypto.randomUUID();
    if (!requestId.trim())
      throw new Error('Actor requestId must not be empty.');

    return this.serialize(
      actor,
      requestId,
      definition.deadlineMs,
      async guard => {
        const stored = await this.load(definition, actor);
        const committed = stored.results.get(requestId);
        if (committed) {
          if (committed.commandFingerprint !== fingerprint) {
            throw new Error(
              `Actor requestId '${requestId}' was already used for a different command.`,
            );
          }
          return structuredClone(committed.result) as R;
        }

        // The handler receives a clone. Mutation followed by throw cannot leak
        // into committed state, which is essential for retry-safe actor turns.
        const workingState = structuredClone(stored.state) as S;
        const turn = await definition.receive(
          {actor, requestId},
          workingState,
          parsedCommand,
        );
        const nextState = definition.state.parse(turn.state);
        const result = definition.result.parse(turn.result);
        // This runtime keeps no journal and so never persists `turn.events`,
        // but it still validates them (see `assertJsonPortableEvents`) — a
        // value that would silently diverge on a journaling adapter must
        // fail loudly here too, before an app ever depends on it.
        assertJsonPortableEvents(turn.events);
        // The in-process counterpart of the Redis lease-token check, and the
        // reason an abandoned turn cannot corrupt the seat: the deadline already
        // freed it, so a later turn may have committed off the state this one
        // read. Nothing suspends between here and the writes below, so the flag
        // cannot flip mid-commit. The throw lands in a race that settled at the
        // deadline and is discarded there; the caller already has its error.
        //
        // The clock is checked alongside the flag because a timer cannot
        // preempt synchronous work: a `receive` that busy-spins past the
        // deadline arrives here with `expired` still false, since the
        // continuation runs as a microtask ahead of the expired timer. See
        // `turnDeadlinePassed`.
        if (
          guard.expired ||
          turnDeadlinePassed(guard.startedAt, definition.deadlineMs)
        ) {
          throw new TurnTimeoutError(actor, requestId, definition.deadlineMs);
        }

        // One in-memory commit point. A durable adapter must make these writes
        // atomic with acknowledgement of the command envelope.
        stored.state = structuredClone(nextState);
        stored.results.set(requestId, {
          commandFingerprint: fingerprint,
          result: structuredClone(result),
        });
        // Bound the dedup map. Map preserves insertion order, so the first key is
        // the oldest; the entry just added is newest and survives eviction.
        while (stored.results.size > this.dedupLimit) {
          const oldest = stored.results.keys().next().value as string;
          stored.results.delete(oldest);
        }
        return structuredClone(result);
      },
    );
  }

  private assertRegistered<S, C, R>(
    definition: ActorDefinition<S, C, R>,
  ): void {
    if (this.definitions.get(definition.name) !== definition) {
      throw new Error(`Actor type '${definition.name}' is not registered.`);
    }
  }

  /**
   * The stored record for one identity, creating it on first touch.
   *
   * **First writer wins**, and the re-check after the `await` is load-bearing.
   * `initialState` may be async, and a turn is no longer guaranteed to be alone
   * on its seat for as long as it runs: a deadline frees the seat while the
   * abandoned turn keeps going (see `serialize`). So a *second* turn can create
   * this identity — and commit state, a dedup record and journal entries to
   * it — while the first turn is still awaiting the line below. Publishing our
   * fresh record then would reset committed state, drop the dedup map (letting
   * an already-committed `requestId` run a second time), and on the event-log
   * runtime restart `seq` at 0, colliding with `(actor, seq)` pairs subscribers
   * have already been handed.
   */
  private async load<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    actor: ActorId,
  ): Promise<StoredActor> {
    const key = actorKey(actor);
    const existing = this.actors.get(key);
    if (existing) return existing;
    const state = structuredClone(
      definition.state.parse(await definition.initialState(actor.id)),
    );
    const raced = this.actors.get(key);
    if (raced) return raced;
    const stored: StoredActor = {state, results: new Map()};
    this.actors.set(key, stored);
    return stored;
  }

  /**
   * Run one turn with the seat to itself, under the definition's deadline.
   *
   * The deadline starts once the seat is free, not when the call arrives:
   * queueing behind another turn must never count against a turn's own budget.
   * When it fires, the seat is released immediately (the `finally` below) —
   * the abandoned action is no longer awaited by anyone, so the next turn runs
   * at once rather than queueing behind a promise that may never settle. That
   * is the whole "never a wedge" half of the invariant; the `guard` is the
   * other half, and stops the abandoned turn from committing later.
   */
  private async serialize<T>(
    actor: ActorId,
    requestId: string,
    deadlineMs: number,
    action: (guard: TurnGuard) => Promise<T>,
  ): Promise<T> {
    const key = actorKey(actor);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous;
    // `startedAt` is stamped here, with the flag: the deadline starts once the
    // seat is free, and both halves of the check must measure from the same
    // instant.
    const guard: TurnGuard = {expired: false, startedAt: Date.now()};
    try {
      return await raceTurnDeadline(
        action(guard),
        actor,
        requestId,
        deadlineMs,
        guard,
      );
    } catch (err) {
      // A timeout is a recorded failed turn. This runtime keeps no journal,
      // so the log line is the whole record (`EventSourcedActorRuntime` also
      // appends an `actor.turn.timeout` entry to the identity's log) — and,
      // like every `loggers` call, it is only actually written when its
      // namespace is enabled (`DEBUG=agentback:actors:deadline:*`).
      //
      // Gated on identity, not just type: a `TurnTimeoutError` from a nested
      // actor call passes through this frame, and it is already recorded by
      // the turn that owns it. See `isOwnTurnTimeout`.
      if (isOwnTurnTimeout(err, actor, requestId)) logTimedOutTurn(err);
      throw err;
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
