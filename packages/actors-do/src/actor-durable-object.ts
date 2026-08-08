// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  actorCommandFingerprint,
  assertJsonPortableEvents,
  isOwnTurnTimeout,
  logTimedOutTurn,
  raceTurnDeadline,
  turnDeadlinePassed,
  turnTimeoutEvent,
  TurnTimeoutError,
  type ActorCommandContext,
  type ActorDefinition,
  type ActorEvent,
  type ActorId,
  type CommittedActorEvent,
  type TurnGuard,
} from '@agentback/actors';
import type {ActorDoState, ActorDoStub} from './do-surface.js';
import {serializeActorError} from './protocol.js';
import type {ReadStateOutcome, TurnOutcome, TurnRequest} from './protocol.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActorDefinition = ActorDefinition<any, any, any>;

/**
 * The one stored record of an identity. State, the dedup map, and the journal
 * seq counter live together so the commit is a single atomic multi-key `put`
 * of this record plus the turn's `event:*` entries.
 *
 * `results` is an insertion-ordered pair list (not a Map — storage values are
 * plain JSON), bounded FIFO like the in-memory adapters' dedup map.
 */
interface StoredRecord {
  actor: ActorId;
  state: unknown;
  seq: number;
  results: Array<
    [requestId: string, entry: {commandFingerprint: string; result: unknown}]
  >;
}

const RECORD_KEY = 'record';
const EVENT_KEY_PREFIX = 'event:';

/** Zero-padded so storage `list({prefix})` key order is seq order. */
function eventKey(seq: number): string {
  return `${EVENT_KEY_PREFIX}${String(seq).padStart(12, '0')}`;
}

type Phase1 =
  | {kind: 'replay'; result: unknown}
  | {
      kind: 'turn';
      nextState: unknown;
      result: unknown;
      events: readonly ActorEvent[];
      seatKeyId: string;
    };

export interface CreateActorDurableObjectOptions {
  /** Max committed request results retained for idempotent replay. Default 1024. */
  dedupLimit?: number;
}

export interface ActorDurableObjectClass {
  new (state: ActorDoState, env?: unknown): ActorDoStub;
}

/**
 * Build the Durable Object class that hosts actor turns — **one object per
 * actor identity** (the runtime addresses it via
 * `idFromName(type + '\u0000' + id)`).
 *
 * `loadDefinitions` supplies the compiled `ActorDefinition`s. It is called
 * lazily, once per object instance, because a Durable Object may run in a
 * different isolate (or on a different machine) than the Worker that invokes
 * it — the definitions must be constructible from the module graph both sides
 * share, not captured from the caller's live runtime. In a Cloudflare/celld
 * deployment this is typically `() => compileAppActorDefinitions()`; the
 * in-process host closes over the caller-side runtime's registrations.
 *
 * The turn contract mirrors `EventSourcedActorRuntime` exactly, with one
 * structural difference an async store forces: the deadline races **load +
 * receive only**, and the commit runs outside the race, serialized through a
 * single storage section. An abandoned turn (deadline fired mid-phase) never
 * reaches its commit — the race discards the continuation — so the only
 * abandoned write left is `initialState` persistence, which re-checks
 * first-writer-wins inside the section. That is this adapter's counterpart of
 * the Redis lease-token check and the in-memory guard-at-commit.
 */
export function createActorDurableObject(
  loadDefinitions: () =>
    | readonly AnyActorDefinition[]
    | Promise<readonly AnyActorDefinition[]>,
  options: CreateActorDurableObjectOptions = {},
): ActorDurableObjectClass {
  const dedupLimit = options.dedupLimit ?? 1024;
  if (!Number.isInteger(dedupLimit) || dedupLimit < 1) {
    throw new Error('dedupLimit must be a positive integer.');
  }

  return class ActorDurableObject implements ActorDoStub {
    readonly #storage: ActorDoState['storage'];
    #definitions?: Promise<Map<string, AnyActorDefinition>>;
    /** The seat: one identity per object, so one turn at a time per object. */
    #seatTail: Promise<void> = Promise.resolve();
    /** Serializes every read-modify-write storage section (init/commit/marker). */
    #storageTail: Promise<void> = Promise.resolve();

    constructor(state: ActorDoState, _env?: unknown) {
      this.#storage = state.storage;
    }

    async turn(request: TurnRequest): Promise<TurnOutcome> {
      try {
        return {ok: true, result: await this.#turn(request)};
      } catch (err) {
        return {ok: false, error: serializeActorError(err)};
      }
    }

    async readState(actor: ActorId): Promise<ReadStateOutcome> {
      try {
        const definition = await this.#definition(actor.type);
        const record = await this.#storage.get<StoredRecord>(RECORD_KEY);
        if (record) return {ok: true, state: record.state};
        // A read must not mutate: compute the initial state without storing.
        const state: unknown = definition.state.parse(
          await definition.initialState(actor.id),
        );
        return {ok: true, state};
      } catch (err) {
        return {ok: false, error: serializeActorError(err)};
      }
    }

    async readEvents(): Promise<CommittedActorEvent[]> {
      const entries = await this.#storage.list<CommittedActorEvent>({
        prefix: EVENT_KEY_PREFIX,
      });
      return [...entries.values()];
    }

    async #turn(request: TurnRequest): Promise<unknown> {
      const {actor, requestId} = request;
      const definition = await this.#definition(actor.type);
      const parsedCommand: unknown = definition.command.parse(request.command);
      const fingerprint = actorCommandFingerprint(parsedCommand);

      // Acquire the seat. The deadline starts once the seat is free — queueing
      // behind another turn never counts against a turn's own budget.
      const previous = this.#seatTail;
      let release!: () => void;
      this.#seatTail = new Promise<void>(resolve => {
        release = resolve;
      });
      await previous;

      const guard: TurnGuard = {expired: false, startedAt: Date.now()};
      try {
        const phase = await raceTurnDeadline(
          this.#loadAndReceive(
            definition,
            actor,
            requestId,
            parsedCommand,
            fingerprint,
          ),
          actor,
          requestId,
          definition.deadlineMs,
          guard,
        );
        if (phase.kind === 'replay') return phase.result;
        return await this.#commit(
          actor,
          requestId,
          fingerprint,
          phase,
          guard,
          definition.deadlineMs,
        );
      } catch (err) {
        // A timeout is a recorded failed turn — gated on turn identity, never
        // error type, so a nested inner timeout passing through this frame is
        // recorded only by the turn that owns it (see `isOwnTurnTimeout`).
        // Awaited before the seat is released, so the journal records
        // incident order.
        if (isOwnTurnTimeout(err, actor, requestId)) {
          logTimedOutTurn(err);
          await this.#appendTimeoutMarker(err);
        }
        throw err;
      } finally {
        release();
      }
    }

    async #loadAndReceive(
      definition: AnyActorDefinition,
      actor: ActorId,
      requestId: string,
      parsedCommand: unknown,
      fingerprint: string,
    ): Promise<Phase1> {
      const record = await this.#ensureRecord(definition, actor);
      const committed = record.results.find(([id]) => id === requestId)?.[1];
      if (committed) {
        if (committed.commandFingerprint !== fingerprint) {
          throw new Error(
            `Actor requestId '${requestId}' was already used for a different command.`,
          );
        }
        return {kind: 'replay', result: committed.result};
      }

      // The handler receives a clone: mutation followed by a throw cannot
      // leak into the stored record.
      const workingState: unknown = structuredClone(record.state);
      const ctx: ActorCommandContext = {actor, requestId};
      const turn = await definition.receive(ctx, workingState, parsedCommand);
      const nextState: unknown = definition.state.parse(turn.state);
      const result: unknown = definition.result.parse(turn.result);
      assertJsonPortableEvents(turn.events);
      return {
        kind: 'turn',
        nextState,
        result,
        events: turn.events ?? [],
        seatKeyId: ctx.seatKeyId ?? '',
      };
    }

    /**
     * The stored record, creating and persisting it on first touch.
     *
     * `initialState` runs **outside** the storage section — it is
     * caller-authored and may be slow, and a deadline that frees the seat must
     * let the next turn's own section run at once, not queue behind a hung
     * load. First writer wins: the re-check inside the section is what stops a
     * late `initialState` from resetting an identity another turn has already
     * committed to (state, dedup, and journal seq alike).
     */
    async #ensureRecord(
      definition: AnyActorDefinition,
      actor: ActorId,
    ): Promise<StoredRecord> {
      const existing = await this.#storage.get<StoredRecord>(RECORD_KEY);
      if (existing) return existing;
      const state: unknown = definition.state.parse(
        await definition.initialState(actor.id),
      );
      return this.#storageSection(async () => {
        const raced = await this.#storage.get<StoredRecord>(RECORD_KEY);
        if (raced) return raced;
        const record: StoredRecord = {actor, state, seq: 0, results: []};
        await this.#storage.put({[RECORD_KEY]: record});
        return record;
      });
    }

    /**
     * The one commit point: state, dedup result, and journal entries advance
     * in a single atomic multi-key `put`. Only a turn whose phase settled the
     * deadline race can reach this — the guard/elapsed check at the top is the
     * commit-boundary re-check every adapter performs, and inside the section
     * nothing else can write between it and the `put`.
     */
    async #commit(
      actor: ActorId,
      requestId: string,
      fingerprint: string,
      phase: Extract<Phase1, {kind: 'turn'}>,
      guard: TurnGuard,
      deadlineMs: number,
    ): Promise<unknown> {
      return this.#storageSection(async () => {
        // The clock is checked alongside the flag because a timer cannot
        // preempt synchronous work: a `receive` that busy-spins past the
        // deadline settles the race before the expired timer's callback runs.
        if (guard.expired || turnDeadlinePassed(guard.startedAt, deadlineMs)) {
          throw new TurnTimeoutError(actor, requestId, deadlineMs);
        }
        const record = await this.#storage.get<StoredRecord>(RECORD_KEY);
        if (!record) {
          throw new Error(
            `Actor record for '${actor.type}/${actor.id}' vanished before commit.`,
          );
        }
        record.state = phase.nextState;
        record.results.push([
          requestId,
          {commandFingerprint: fingerprint, result: phase.result},
        ]);
        while (record.results.length > dedupLimit) record.results.shift();

        const entries: Record<string, unknown> = {};
        for (const event of phase.events) {
          const committedEvent: CommittedActorEvent = {
            actor,
            seq: record.seq++,
            requestId,
            seatKeyId: phase.seatKeyId,
            event,
          };
          entries[eventKey(committedEvent.seq)] = committedEvent;
        }
        entries[RECORD_KEY] = record;
        await this.#storage.put(entries);
        return phase.result;
      });
    }

    /**
     * "A timeout is a recorded failed turn": append the marker to the journal.
     * Its own write — it touches neither state nor the dedup list, so the
     * timed-out `requestId` stays retryable. It consumes a seq, so the log
     * reads in incident order. A cold identity whose record was never
     * persisted gets the log line only (same as `EventSourcedActorRuntime`).
     */
    async #appendTimeoutMarker(error: TurnTimeoutError): Promise<void> {
      await this.#storageSection(async () => {
        const record = await this.#storage.get<StoredRecord>(RECORD_KEY);
        if (!record) return;
        const committedEvent: CommittedActorEvent = {
          actor: error.actor,
          seq: record.seq++,
          requestId: error.requestId,
          seatKeyId: '',
          event: turnTimeoutEvent(error.deadlineMs),
        };
        await this.#storage.put({
          [RECORD_KEY]: record,
          [eventKey(committedEvent.seq)]: committedEvent,
        });
      });
    }

    #definition(type: string): Promise<AnyActorDefinition> {
      this.#definitions ??= Promise.resolve(loadDefinitions()).then(
        definitions => {
          const byName = new Map<string, AnyActorDefinition>();
          for (const definition of definitions) {
            const existing = byName.get(definition.name);
            if (existing && existing !== definition) {
              throw new Error(
                `Actor type '${definition.name}' is defined twice.`,
              );
            }
            byName.set(definition.name, definition);
          }
          return byName;
        },
      );
      return this.#definitions.then(byName => {
        const definition = byName.get(type);
        if (!definition) {
          throw new Error(
            `Actor type '${type}' is not registered with this Durable Object.`,
          );
        }
        return definition;
      });
    }

    /** Run one read-modify-write section, serialized against every other. */
    #storageSection<T>(fn: () => Promise<T>): Promise<T> {
      const run = this.#storageTail.then(fn, fn);
      this.#storageTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }
  };
}
