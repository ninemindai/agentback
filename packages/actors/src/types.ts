// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z, type ZodType} from 'zod';
import type {ActorSeatClass} from './deadlines.js';

/** Stable identity of one logical actor instance. */
export interface ActorId {
  readonly type: string;
  readonly id: string;
}

/** Metadata for one command delivery. */
export interface ActorCommandContext {
  readonly actor: ActorId;
  readonly requestId: string;
  /**
   * Seat key identity of the acting seat, journaled with each of this turn's
   * events. Runtime-owned, not `ActorTurn`'s: a runtime constructs `ctx` and
   * passes it into `receive` by reference, then — *after* `receive` resolves
   * — reads `ctx.seatKeyId` back out to stamp the committed event. A command
   * method's return value can never carry this (it is not a field of
   * `ActorTurn`); it can only mutate `ctx.seatKeyId` in place during the
   * call, and the compiled `@actor` path (`ActorRegistry`) always overwrites
   * that mutation once `receive` returns (see the "discards a ctx.seatKeyId
   * mutation" test in `registry.unit.ts`).
   *
   * `ActorRegistry` sets this from `ensureSeatKey`, leaving it unset when no
   * `SeatKeyStore` is bound. A raw `defineActor` caller is the trusted
   * low-level layer: nothing stops its own `receive` from setting
   * `ctx.seatKeyId` itself, and a runtime honors that exactly the same way.
   */
  seatKeyId?: string;
}

/** Context for one query. Queries are read-only, so there is no `requestId`. */
export interface ActorQueryContext {
  readonly actor: ActorId;
}

/** A domain fact emitted by a command turn. Must be JSON-serializable. */
export interface ActorEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** State and reply produced by one successful actor turn. */
export interface ActorTurn<S, R> {
  state: S;
  result: R;
  /**
   * Domain events produced by this turn. An event-log runtime
   * (`EventSourcedActorRuntime`) appends them to the identity's append-only log
   * atomically with the state/dedup commit; other runtimes ignore them.
   */
  events?: readonly ActorEvent[];
}

/** One committed event with its position in an identity's append-only log. */
export interface CommittedActorEvent {
  readonly actor: ActorId;
  /** 0-based position in this identity's log. */
  readonly seq: number;
  /** The `requestId` of the turn that produced it. */
  readonly requestId: string;
  /**
   * Seat key identity of the seat that committed the turn. Always present —
   * every journaling runtime stamps it at commit. `''` is the documented "no
   * seat layer" sentinel: the acting identity had no key row because no
   * `SeatKeyStore` was bound (an app without the seat layer configured keeps
   * working; see `ActorRegistry`'s `ensureSeatKey`). A non-empty value names
   * the row in the bound `SeatKeyStore`.
   */
  readonly seatKeyId: string;
  readonly event: ActorEvent;
}

/**
 * Runtime validator for `CommittedActorEvent`. `seatKeyId` must be a string
 * (the `''` sentinel is valid) — an event object that omits the field
 * entirely, as a pre-seat-layer wire format would, fails
 * `.parse()`/`.safeParse()`.
 */
export const CommittedActorEventSchema = z.object({
  actor: z.object({type: z.string(), id: z.string()}),
  seq: z.number(),
  requestId: z.string(),
  seatKeyId: z.string(),
  event: z.object({type: z.string()}).catchall(z.unknown()),
});

/**
 * Read half of an identity's append-only event log (Event = fact). Split from
 * `ActorEventStore` so a runtime can persist and read back its journal without
 * also offering in-process delivery. `ActorRegistry.events` delegates to it.
 */
export interface ActorEventReader {
  /** The committed events for one identity, in order. */
  events(type: string, id: string): Promise<readonly CommittedActorEvent[]>;
}

/**
 * Capability of a runtime that persists an append-only event log per identity
 * **and** delivers each event in process. `ActorRegistry.subscribe` requires it.
 */
export interface ActorEventStore extends ActorEventReader {
  /**
   * Observe every event as it commits. Returns an unsubscribe function.
   *
   * **The consumer contract: be idempotent by `(actor, seq)`, and expect late
   * replay.** The durable log is the source of truth and live delivery is
   * best effort, so a handler is called *at least* once per committed event,
   * never exactly once. A durable adapter (`RedisActorRuntime`) tails the log
   * and, whenever it (re)connects — a dropped socket, a redeployed process —
   * resumes by replaying everything after the cursor it still holds; a
   * restarted process holds none, so it replays the identity's log from
   * `seq` 0. That is normal operation, not an error path: a consumer that
   * keeps its own `(actor, seq)` high-water mark (or writes with an
   * idempotency key derived from it) sees each fact once, and one that
   * assumes single delivery double-counts on the first reconnect.
   *
   * Ordering is guaranteed per identity (`seq` ascending) and unspecified
   * across identities. A handler that throws is logged and skipped — it never
   * stalls the tail, fails the committing turn, or affects another
   * subscriber — and its event is not retried, because the log is still there
   * to be replayed by `seq`.
   */
  subscribe(handler: (event: CommittedActorEvent) => void): () => void;
}

/** Service-class contract used by the decorated actor authoring model. */
export interface Actor<S> {
  initialState(id: string): S | Promise<S>;
}

/** Runtime envelope produced by an `@actorCommand` method. */
export interface ActorServiceCommand {
  name: string;
  input: unknown;
}

/** Runtime envelope returned by an `@actorCommand` method. */
export interface ActorServiceResult {
  name: string;
  output: unknown;
}

/**
 * Typed actor behavior. A runtime must serialize `receive` calls per actor ID
 * and commit state only after both state and result pass validation.
 */
export interface ActorDefinition<S, C, R> {
  readonly name: string;
  readonly state: ZodType<S>;
  /** Commands must decode to JSON-serializable values for adapter portability. */
  readonly command: ZodType<C>;
  readonly result: ZodType<R>;
  readonly initialState: (id: string) => S | Promise<S>;
  readonly receive: (
    ctx: ActorCommandContext,
    state: S,
    command: C,
  ) => ActorTurn<S, R> | Promise<ActorTurn<S, R>>;
  /** Deadline band these turns run under. See `ActorSeatClass`. */
  readonly seatClass: ActorSeatClass;
  /**
   * Resolved per-turn deadline in milliseconds — always a number, because
   * `defineActor` folds the seat-class default in. A turn that outlives it is
   * abandoned with a `TurnTimeoutError` and recorded as a failed turn; it can
   * never commit afterwards.
   */
  readonly deadlineMs: number;
  readonly __kind: 'actor';
}

export interface DefineActorOptions<S, C, R> {
  state: ZodType<S>;
  command: ZodType<C>;
  result: ZodType<R>;
  initialState: (id: string) => S | Promise<S>;
  receive: ActorDefinition<S, C, R>['receive'];
  /** Deadline band. Default `'capability'` (30s); `'worker'` is 10 minutes. */
  seatClass?: ActorSeatClass;
  /** Explicit per-turn deadline in ms. Overrides the seat class's default. */
  deadlineMs?: number;
}

/** Options controlling one actor command. */
export interface ActorInvokeOptions {
  /** Idempotency key. Reusing it returns the committed result without rerun. */
  requestId?: string;
}

/** Typed, location-independent handle to one actor identity. */
export interface ActorRef<C, R> {
  readonly actor: ActorId;
  invoke(command: C, options?: ActorInvokeOptions): Promise<R>;
}

/**
 * Actor hosting seam. Durable/distributed adapters must preserve the same
 * per-ID serialization, rollback, validation, and request-dedup semantics.
 */
export interface ActorRuntime {
  register<S, C, R>(definition: ActorDefinition<S, C, R>): void;
  ref<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    id: string,
  ): ActorRef<C, R>;
  state<S, C, R>(definition: ActorDefinition<S, C, R>, id: string): Promise<S>;
}
