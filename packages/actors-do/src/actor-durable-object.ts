// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
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

const log = loggers('agentback:actors:do');

/**
 * The core stored record of an identity: authoritative state + the journal
 * seq counter. Deliberately **small** — dedup results live in their own
 * per-request keys, because Durable Object storage caps a single entry
 * (128 KiB per value on KV-backed classes, 2 MB key+value on SQLite-backed
 * ones). A record that also carried up to `dedupLimit` results would grow
 * past those caps under real payloads and brick the identity: every later
 * commit rewrites the same oversized value and fails. Splitting also makes
 * the replay lookup one O(1) `get` instead of a scan, and stops every commit
 * from rewriting the whole dedup history.
 */
interface StoredRecord {
  actor: ActorId;
  state: unknown;
  seq: number;
}

/** One committed request result, stored under `dedup:<requestId>`. */
interface DedupEntry {
  commandFingerprint: string;
  result: unknown;
}

const RECORD_KEY = 'record';
const EVENT_KEY_PREFIX = 'event:';
const DEDUP_KEY_PREFIX = 'dedup:';
/**
 * FIFO index of live dedup requestIds, its own small key. Order matters for
 * eviction; the entries themselves are per-key so their payloads never share
 * one capped storage value.
 */
const DEDUP_ORDER_KEY = 'dedup-order';

/**
 * Committed events per turn, capped so the commit's atomic multi-key `put`
 * (record + dedup entry + order index + one key per event) stays under the
 * platform's per-call entry limit (128 key-value pairs on Cloudflare's KV
 * put). Enforced on every host — the in-process runtime has no such limit,
 * but an app first exercised in dev must fail loudly before it depends on a
 * turn shape a production adapter cannot commit.
 */
const MAX_EVENTS_PER_TURN = 100;

/**
 * Zero-padded so storage `list({prefix})` key order is seq order. The width
 * is frozen forever once a journal exists (mixed widths would break the
 * ordering), so it is deliberately absurd: 16 digits outlives any identity.
 */
function eventKey(seq: number): string {
  return `${EVENT_KEY_PREFIX}${String(seq).padStart(16, '0')}`;
}

function dedupKey(requestId: string): string {
  return `${DEDUP_KEY_PREFIX}${requestId}`;
}

/**
 * One object hosts exactly one identity, but the object trusts the request to
 * name it — so a mis-routed request (an internal caller addressing actor A's
 * object with actor B's turn) would silently read and write the wrong seat.
 * The stored record remembers the first identity; every later access must
 * match it.
 */
function assertRecordIdentity(record: StoredRecord, actor: ActorId): void {
  if (record.actor.type !== actor.type || record.actor.id !== actor.id) {
    throw new Error(
      `Actor object for '${record.actor.type}/${record.actor.id}' received a ` +
        `request addressed to '${actor.type}/${actor.id}' — mis-routed namespace call.`,
    );
  }
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
  /**
   * Base class the generated Durable Object class extends. On Cloudflare,
   * RPC methods are exposed only from classes extending `DurableObject`
   * (from `cloudflare:workers`) — a module that exists only inside workerd,
   * which is why this package cannot import it and takes it as a parameter:
   *
   * ```ts
   * import {DurableObject} from 'cloudflare:workers';
   * export const ActorDO = createActorDurableObject(defs, {
   *   baseClass: DurableObject,
   * });
   * ```
   *
   * The constructor forwards `(state, env)` to the base. Omit it in-process
   * and on hosts that accept a plain class.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseClass?: new (...args: any[]) => object;
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
    readonly AnyActorDefinition[] | Promise<readonly AnyActorDefinition[]>,
  options: CreateActorDurableObjectOptions = {},
): ActorDurableObjectClass {
  const dedupLimit = options.dedupLimit ?? 1024;
  if (!Number.isInteger(dedupLimit) || dedupLimit < 1) {
    throw new Error('dedupLimit must be a positive integer.');
  }
  const Base = options.baseClass ?? class {};

  return class ActorDurableObject extends Base implements ActorDoStub {
    readonly #storage: ActorDoState['storage'];
    #definitions?: Promise<Map<string, AnyActorDefinition>>;
    /** The seat: one identity per object, so one turn at a time per object. */
    #seatTail: Promise<void> = Promise.resolve();
    /** Serializes every read-modify-write storage section (init/commit/marker). */
    #storageTail: Promise<void> = Promise.resolve();

    constructor(state: ActorDoState, env?: unknown) {
      super(state, env);
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
        if (record) {
          assertRecordIdentity(record, actor);
          return {ok: true, state: record.state};
        }
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
          // The marker is best-effort: a storage failure here must not
          // replace the typed TurnTimeoutError the caller is owed — that
          // would break the timeout contract exactly when storage is
          // degraded.
          try {
            await this.#appendTimeoutMarker(err);
          } catch (markerErr) {
            log.warn(
              'failed to journal timeout marker for %s/%s (request %s): %s',
              actor.type,
              actor.id,
              requestId,
              markerErr,
            );
          }
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
      assertRecordIdentity(record, actor);
      const committed = await this.#storage.get<DedupEntry>(
        dedupKey(requestId),
      );
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
      if ((turn.events?.length ?? 0) > MAX_EVENTS_PER_TURN) {
        throw new Error(
          `Actor turn for '${actor.type}/${actor.id}' emitted ${turn.events!.length} events; ` +
            `the Durable Objects adapter commits at most ${MAX_EVENTS_PER_TURN} per turn ` +
            `(the commit is one atomic multi-key put, and the platform caps entries per call).`,
        );
      }
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
        const record: StoredRecord = {actor, state, seq: 0};
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
        const order =
          (await this.#storage.get<string[]>(DEDUP_ORDER_KEY)) ?? [];
        order.push(requestId);
        const evicted: string[] = [];
        while (order.length > dedupLimit) evicted.push(order.shift()!);

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
        entries[DEDUP_ORDER_KEY] = order;
        entries[dedupKey(requestId)] = {
          commandFingerprint: fingerprint,
          result: phase.result,
        } satisfies DedupEntry;
        await this.#storage.put(entries);
        // Eviction is deliberately lazy AND best-effort, after the atomic
        // commit: the turn is already durable, so a delete failure must not
        // report a committed turn as failed. An orphaned dedup entry only
        // makes a replay of that evicted requestId *more* correct (it still
        // returns the committed result instead of re-running).
        if (evicted.length) {
          try {
            await this.#storage.delete(evicted.map(dedupKey));
          } catch (err) {
            log.warn(
              'failed to evict %d dedup entries for %s/%s: %s',
              evicted.length,
              actor.type,
              actor.id,
              err,
            );
          }
        }
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
      if (!this.#definitions) {
        const memo = Promise.resolve(loadDefinitions()).then(definitions => {
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
        });
        // A transient loader failure must not poison the object until the
        // platform happens to evict it: drop the memo so the next call
        // retries. (The catch also keeps the rejection handled when the
        // caller chain is abandoned.)
        memo.catch(() => {
          if (this.#definitions === memo) this.#definitions = undefined;
        });
        this.#definitions = memo;
      }
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
