// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {
  BindingScope,
  ContextTags,
  injectable,
  type Component,
} from '@agentback/core';
import {
  isOwnTurnTimeout,
  logTimedOutTurn,
  raceTurnDeadline,
  turnDeadlinePassed,
  turnTimeoutEvent,
  TurnTimeoutError,
  type TurnGuard,
} from './deadlines.js';
import {
  actorCommandFingerprint,
  assertJsonPortableEvents,
} from './in-memory-runtime.js';
import {ACTOR_RUNTIME} from './keys.js';
import {ActorRegistry} from './registry.js';
import {assertActorIdentityPart} from './types.js';
import type {
  ActorCommandContext,
  ActorDefinition,
  ActorEventStore,
  ActorId,
  ActorInvokeOptions,
  ActorRef,
  ActorRuntime,
  CommittedActorEvent,
} from './types.js';

const log = loggers('agentback:actors:events');

interface StoredActor {
  state: unknown;
  seq: number;
  events: CommittedActorEvent[];
  results: Map<string, {commandFingerprint: string; result: unknown}>;
}

function actorKey(actor: ActorId): string {
  return `${actor.type}\u0000${actor.id}`;
}

export interface EventSourcedActorRuntimeOptions {
  /** Max committed request results retained per actor for replay. Default 1024. */
  dedupLimit?: number;
}

/**
 * Single-process reference adapter that keeps the authoritative state **and**
 * an append-only event log per identity. A command turn's `events` are
 * committed atomically with its state + dedup result, then delivered to
 * subscribers — so events are durable facts you can read back or react to,
 * without an event-sourced authoring model (state is still stored, not folded).
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_RUNTIME.key},
})
export class EventSourcedActorRuntime implements ActorRuntime, ActorEventStore {
  private readonly definitions = new Map<string, object>();
  private readonly actors = new Map<string, StoredActor>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly subscribers = new Set<
    (e: CommittedActorEvent) => void | Promise<void>
  >();
  private readonly dedupLimit: number;

  constructor(options: EventSourcedActorRuntimeOptions = {}) {
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
    // Lease-free read (see InMemoryActorRuntime): no mailbox slot.
    const stored = this.actors.get(actorKey({type: definition.name, id}));
    if (!stored) {
      return structuredClone(
        definition.state.parse(await definition.initialState(id)),
      ) as S;
    }
    return structuredClone(stored.state) as S;
  }

  async events(
    type: string,
    id: string,
  ): Promise<readonly CommittedActorEvent[]> {
    assertActorIdentityPart('type', type);
    assertActorIdentityPart('id', id);
    const stored = this.actors.get(actorKey({type, id}));
    return stored ? stored.events.map(event => structuredClone(event)) : [];
  }

  subscribe(
    handler: (event: CommittedActorEvent) => void | Promise<void>,
  ): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
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

        const workingState = structuredClone(stored.state) as S;
        // Held onto (not inlined) so the seat key stamped onto it by `receive`
        // — see ActorCommandContext.seatKeyId — is still readable afterward.
        const ctx: ActorCommandContext = {actor, requestId};
        const turn = await definition.receive(ctx, workingState, parsedCommand);
        const nextState = definition.state.parse(turn.state);
        const result = definition.result.parse(turn.result);
        // Every event must be plain, finite JSON before it is even eligible
        // to commit — see `assertJsonPortableEvents` for why this runtime's
        // own `structuredClone` persistence is not itself a strong enough
        // guarantee (it happily preserves a Date or `undefined`, which Redis
        // does not).
        assertJsonPortableEvents(turn.events);
        // The in-process counterpart of the Redis lease-token check: the seat
        // was freed at the deadline, so this abandoned turn must not commit.
        // Nothing suspends between here and the writes below (see
        // InMemoryActorRuntime for the full note). The clock is checked
        // alongside the flag because a timer cannot preempt synchronous work
        // — see `turnDeadlinePassed`.
        if (
          guard.expired ||
          turnDeadlinePassed(guard.startedAt, definition.deadlineMs)
        ) {
          throw new TurnTimeoutError(actor, requestId, definition.deadlineMs);
        }

        // One commit point: state, dedup result, and the event log all advance
        // together. A durable adapter must make these writes atomic.
        stored.state = structuredClone(nextState);
        stored.results.set(requestId, {
          commandFingerprint: fingerprint,
          result: structuredClone(result),
        });
        while (stored.results.size > this.dedupLimit) {
          const oldest = stored.results.keys().next().value as string;
          stored.results.delete(oldest);
        }
        const delivered: CommittedActorEvent[] = [];
        for (const event of turn.events ?? []) {
          const committedEvent: CommittedActorEvent = {
            actor,
            seq: stored.seq++,
            requestId,
            // No key row (no SeatKeyStore bound) commits the documented ''
            // sentinel — see ActorCommandContext.seatKeyId.
            seatKeyId: ctx.seatKeyId ?? '',
            event: structuredClone(event),
          };
          stored.events.push(committedEvent);
          delivered.push(committedEvent);
        }

        // Notify after the commit; a throwing subscriber must not fail the turn.
        for (const committedEvent of delivered) this.deliver(committedEvent);
        return structuredClone(result);
      },
    );
  }

  /**
   * Hand one committed event to every subscriber, skipping the ones that fail.
   *
   * Handlers are **not awaited**, and a returned promise is caught rather than
   * sequenced. Delivery runs inside the committing turn here (unlike the Redis
   * adapter, where it is a separate tail loop that can afford to await), so
   * awaiting would make a slow subscriber hold up the turn — the one thing
   * `ActorEventStore.subscribe` promises delivery never does. Attaching a
   * `.catch` keeps that fire-and-forget shape while bringing an async
   * handler's rejection under the same "logged and skipped" contract as a
   * synchronous throw; without it the rejection escaped this frame entirely
   * and surfaced as an unhandled rejection.
   */
  private deliver(committedEvent: CommittedActorEvent): void {
    for (const handler of this.subscribers) {
      try {
        void Promise.resolve(handler(structuredClone(committedEvent))).catch(
          err => this.logSkippedSubscriber(committedEvent, err),
        );
      } catch (err) {
        // Skipped, but never silently: the port documents a throwing
        // subscriber as "logged and skipped".
        this.logSkippedSubscriber(committedEvent, err);
      }
    }
  }

  private logSkippedSubscriber(
    committedEvent: CommittedActorEvent,
    err: unknown,
  ): void {
    log.error(
      'subscriber threw on %s/%s#%d and was skipped: %s',
      committedEvent.actor.type,
      committedEvent.actor.id,
      committedEvent.seq,
      err,
    );
  }

  /**
   * "A timeout is a recorded failed turn": append the failed turn to the
   * identity's journal, alongside the log line every runtime emits.
   *
   * This is its **own** write. It touches neither state nor the dedup record,
   * so the one commit point is untouched and the timed-out `requestId` stays
   * free to run on retry rather than replaying a failure it never committed.
   * It consumes a seq, so the log reads in the order things actually
   * happened.
   *
   * `seatKeyId` is the `''` sentinel: the acting seat's key row is stamped on
   * `ctx` only once `receive` returns, and a timed-out turn's never did. See
   * `CommittedActorEvent.seatKeyId`, which documents both meanings of `''`.
   *
   * An identity with no stored record yet gets the log line only: there is no
   * journal to append to until the identity is loaded. That is reachable here
   * because `serialize` races the **whole** action — the state load, and so
   * `initialState`, included — so a deadline can fire before the turn ever
   * reaches `receive`.
   *
   * `RedisActorRuntime` races the state load too, and differs only in what it
   * can record for that case: its journal is a Redis Stream the marker's own
   * `XADD` creates, so a cold identity that times out mid-load gets a marker
   * there and a log line here. Every marker for a turn that reached `receive`
   * lands on both.
   */
  private recordTimedOutTurn(error: TurnTimeoutError): void {
    const stored = this.actors.get(actorKey(error.actor));
    if (!stored) return;
    const committedEvent: CommittedActorEvent = {
      actor: error.actor,
      seq: stored.seq++,
      requestId: error.requestId,
      seatKeyId: '',
      event: turnTimeoutEvent(error.deadlineMs),
    };
    stored.events.push(committedEvent);
    this.deliver(committedEvent);
  }

  private assertRegistered<S, C, R>(
    definition: ActorDefinition<S, C, R>,
  ): void {
    if (this.definitions.get(definition.name) !== definition) {
      throw new Error(`Actor type '${definition.name}' is not registered.`);
    }
  }

  /**
   * First writer wins — see `InMemoryActorRuntime.load` for why the re-check
   * after the `await` is load-bearing. It matters most here: publishing a
   * fresh record over one another turn already committed to would restart
   * `seq` at 0 and hand subscribers a second, different event at an
   * `(actor, seq)` pair they have already seen, which the consumer contract
   * (idempotent by `(actor, seq)`) gives them no way to detect.
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
    const stored: StoredActor = {state, seq: 0, events: [], results: new Map()};
    this.actors.set(key, stored);
    return stored;
  }

  /** One turn, seat to itself, under the definition's deadline. See
   * `InMemoryActorRuntime.serialize` for why the seat is freed at the deadline
   * and what the `guard` is for. */
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
    // Stamped with the flag: the deadline starts once the seat is free, and
    // both halves of the commit-boundary check measure from the same instant.
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
      // Gated on identity, not just type: a `TurnTimeoutError` from a nested
      // actor call passes through this frame on its way out, and the turn that
      // owns it already journaled it. Recording here would append a second
      // marker — to the *inner* actor's log — for one incident. See
      // `isOwnTurnTimeout`.
      if (isOwnTurnTimeout(err, actor, requestId)) {
        logTimedOutTurn(err);
        this.recordTimedOutTurn(err);
      }
      throw err;
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

/** Binds the actor runtime port to the event-logging reference adapter. */
export class EventSourcedActorsComponent implements Component {
  services = [EventSourcedActorRuntime, ActorRegistry];
}
