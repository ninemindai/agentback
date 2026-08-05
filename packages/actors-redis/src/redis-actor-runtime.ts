// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ACTOR_RUNTIME,
  actorCommandFingerprint,
  assertActorIdentityPart,
  CommittedActorEventSchema,
  isOwnTurnTimeout,
  logTimedOutTurn,
  raceTurnDeadline,
  turnDeadlinePassed,
  turnTimeoutEvent,
  TurnTimeoutError,
  type ActorCommandContext,
  type ActorDefinition,
  type ActorEvent,
  type ActorEventStore,
  type ActorId,
  type ActorInvokeOptions,
  type ActorRef,
  type ActorRuntime,
  type CommittedActorEvent,
} from '@agentback/actors';
import {loggers} from '@agentback/common';
import {BindingScope, ContextTags, inject, injectable} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {REDIS_ACTOR_CONNECTIONS, REDIS_ACTOR_OPTIONS} from './keys.js';
import {
  RedisJournalSubscription,
  type JournalSource,
  type JournalSubscribeOptions,
} from './stream-subscriber.js';

const log = loggers('agentback:actors:redis');

/**
 * Redis key prefix every key of this package hangs off. Shared with
 * `SeatJournalConsumerHost`, which stores its cursors alongside the journals
 * they point into, so the two cannot drift onto different keyspaces.
 */
export const DEFAULT_ACTOR_PREFIX = 'agentback:actors';

// The lease token (a UUID held in KEYS[1]) is the sole mutual-exclusion guard.
// Acquire is one atomic `SET NX PX`. A separate fencing token is unnecessary:
// every state write goes through COMMIT_TURN, which re-checks `GET(lease) ==
// token` atomically in the same Lua call, so a stale holder can never commit —
// Redis itself performs the check-and-set there is no out-of-band write path.
const ACQUIRE_LEASE = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 1 end
return nil
`;

const RENEW_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

const RELEASE_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

/**
 * Largest dedup TTL that keeps `seconds * 1000` a safe integer, and so stays
 * far inside the range `EXPIRE` accepts. Past it, `EXPIRE` raises.
 */
const MAX_DEDUP_TTL_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

// The one commit point. State, the dedup record and the identity's journal all
// advance in this single script execution, so they cannot diverge: a turn whose
// script does not reach the end commits none of them.
//
// Redis does *not* roll back a script that fails partway through, so "commits
// nothing" has to be engineered rather than assumed. Every write below is
// therefore reached only once it is known to succeed:
//
//   - the wrong-type preflight runs before the first write, so a squatted key
//     aborts with WRONG_TYPES having written nothing;
//   - INCRBY, which still raises against a counter holding a non-integer, runs
//     *first*, so its failure also leaves nothing behind;
//   - SET overwrites any type, and HSET/XADD are covered by the preflight;
//   - EXPIRE raises on a fractional or out-of-range TTL, and it sits after
//     writes that have already landed — so the TTL is floored and range-checked
//     here and simply skipped if it is neither. Refreshing dedup retention is
//     worth less than keeping the commit whole. `dedupTtlSeconds` is validated
//     at construction too; this is the belt to that pair of braces.
//
// Journal retention (`journal.maxEventsPerIdentity`) rides along on the same
// `XADD` rather than being a second write or a sweeper: a cap that trims
// outside the commit could observe a log the commit had not finished writing,
// and the one commit point would stop being one script.
//
// The trim is **exact** (`MAXLEN`), not approximate (`MAXLEN ~`). Approximate
// trimming only drops whole macro nodes — `stream-node-max-entries`, 100 by
// default — so a cap below that is silently never honored, and what the cap
// means at all would depend on a server config the caller does not set. Exact
// trimming costs one evicted entry per append at steady state; the expensive
// case is turning retention *on* over an existing long journal, where the
// first commit pays for the whole backlog at once.
//
// What retention must NOT do is disturb the numbering: `seq` comes from the
// counter (KEYS[5]), never from stream length, so a trimmed journal reads as a
// suffix whose entries keep the seq values they were committed with.
//
// KEYS: lease, state, dedup, log, seq   ARGV: token, state, requestId, result,
// dedupTtl, seatKeyId, journalMaxLen, eventCount, event JSON…
const COMMIT_TURN = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local function wrongType(key, want)
  local kind = redis.call('TYPE', key)['ok']
  return kind ~= 'none' and kind ~= want
end
local count = tonumber(ARGV[8])
local maxlen = math.floor(tonumber(ARGV[7]) or 0)
if wrongType(KEYS[2], 'string') or wrongType(KEYS[3], 'hash') then return -1 end
if count > 0 and wrongType(KEYS[4], 'stream') then return -1 end
local base = 0
if count > 0 then base = redis.call('INCRBY', KEYS[5], count) - count end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[3], ARGV[4])
local ttl = math.floor(tonumber(ARGV[5]) or 0)
if ttl > 0 and ttl <= ${MAX_DEDUP_TTL_SECONDS} then
  redis.call('EXPIRE', KEYS[3], ttl)
end
for i = 1, count do
  local seq = tostring(base + i - 1)
  if maxlen > 0 then
    redis.call('XADD', KEYS[4], 'MAXLEN', maxlen, '*',
      'seq', seq,
      'requestId', ARGV[3],
      'seatKeyId', ARGV[6],
      'event', ARGV[8 + i])
  else
    redis.call('XADD', KEYS[4], '*',
      'seq', seq,
      'requestId', ARGV[3],
      'seatKeyId', ARGV[6],
      'event', ARGV[8 + i])
  end
end
return 1
`;

// The failed-turn record for a turn that missed its deadline (capability-os#7).
//
// Deliberately NOT part of COMMIT_TURN: it is its own write, touching neither
// state nor dedup, so the one commit point stays exactly one script and a
// timed-out `requestId` remains free to run on retry rather than replaying a
// failure it never committed.
//
// Deliberately NOT lease-gated either — but that is safe only because of
// *where* it runs: inside `withLease`, before the release, while this holder
// still owns the lease. Ordering is protected by the lease, not by this
// script. Run after the release instead and another process could land a full
// commit in the round trip between, so the journal would record issue order
// rather than incident order. It is left un-gated because a renewal that
// failed mid-turn can lapse the lease early, and dropping the record in
// exactly that case would break the invariant this exists to uphold; an append
// to an append-only log cannot corrupt state or dedup regardless of who writes
// it.
//
// INCRBY runs before XADD for the same reason it does in COMMIT_TURN: it is
// the call that can still raise (a counter holding a non-integer), so a
// failure leaves nothing half-written.
//
// It honors journal retention for the same reason the commit does: an identity
// that only ever times out would otherwise grow without bound, and a cap that
// some appends ignore is not a cap.
//
// On a **cold** identity this is the first write of any kind — the race covers
// the state load, so a hanging `initialState` times out before anything exists
// for the seat. Nothing extra is needed: an absent counter `INCRBY`s to 1 (so
// the marker is seq 0) and `XADD` creates the stream.
//
// KEYS: log, seq   ARGV: requestId, seatKeyId, event JSON, journalMaxLen
const APPEND_TURN_FAILURE = `
local function wrongType(key, want)
  local kind = redis.call('TYPE', key)['ok']
  return kind ~= 'none' and kind ~= want
end
if wrongType(KEYS[1], 'stream') then return -1 end
local maxlen = math.floor(tonumber(ARGV[4]) or 0)
local seq = redis.call('INCRBY', KEYS[2], 1) - 1
if maxlen > 0 then
  redis.call('XADD', KEYS[1], 'MAXLEN', maxlen, '*',
    'seq', tostring(seq),
    'requestId', ARGV[1],
    'seatKeyId', ARGV[2],
    'event', ARGV[3])
else
  redis.call('XADD', KEYS[1], '*',
    'seq', tostring(seq),
    'requestId', ARGV[1],
    'seatKeyId', ARGV[2],
    'event', ARGV[3])
end
return 1
`;

/** A script aborted: a target key exists holding an unexpected type. */
const WRONG_TYPES = -1;

interface StoredState {
  state: unknown;
}

interface StoredResult {
  commandFingerprint: string;
  result: unknown;
}

interface ActorKeys {
  state: string;
  dedup: string;
  lease: string;
  /** Per-identity journal (a Redis Stream), one entry per committed event. */
  log: string;
  /** Journal sequence counter, advanced inside the commit script. */
  seq: string;
}

interface Lease {
  value: string;
  lost: boolean;
  timer?: ReturnType<typeof setInterval>;
}

export interface RedisJournalRetentionOptions {
  /**
   * Keep at most this many entries in each identity's journal, trimmed as
   * part of the same commit that appends.
   *
   * **Unset — the default — keeps everything**, which is the behavior every
   * release so far has had. Setting it makes `events()` return a *suffix* of
   * the log: `seq` still comes from the counter, so surviving entries keep
   * their committed numbering, but the entries below the window are gone.
   * A consumer whose cursor predates the oldest retained entry therefore has
   * a genuine **gap** — replay-from-zero is no longer available. Consumers
   * that need the full history must either archive (the `seat.journal.archiver`
   * extension point exists for exactly this) or run with retention unset.
   */
  maxEventsPerIdentity?: number;
}

export interface RedisActorRuntimeOptions
  // Defaults for every subscription's tail loop; `since` stays per-call,
  // because a cursor belongs to one consumer and not to the runtime.
  extends Pick<JournalSubscribeOptions, 'blockMs' | 'discoveryIntervalMs'> {
  /** Redis key prefix. Default `agentback:actors`. */
  prefix?: string;
  /** Lease duration for one actor turn. Default 30 seconds. */
  leaseMs?: number;
  /** Poll interval while another process owns the actor. Default 25ms. */
  leaseRetryMs?: number;
  /** Maximum time to wait for an actor lease. Default 15 seconds. */
  acquireTimeoutMs?: number;
  /** Sliding TTL for request/result dedup records. Default 24 hours. */
  dedupTtlSeconds?: number;
  /** Opt-in per-identity journal retention. Unset keeps every event. */
  journal?: RedisJournalRetentionOptions;
}

export class ActorLeaseTimeoutError extends Error {
  readonly code = 'actor_lease_timeout';
  constructor(readonly actor: ActorId) {
    super(`Timed out waiting for actor '${actor.type}/${actor.id}'.`);
    this.name = 'ActorLeaseTimeoutError';
  }
}

export class ActorLeaseLostError extends Error {
  readonly code = 'actor_lease_lost';
  constructor(readonly actor: ActorId) {
    super(`Lease was lost while running actor '${actor.type}/${actor.id}'.`);
    this.name = 'ActorLeaseLostError';
  }
}

/**
 * Redis-backed ActorRuntime. Actor definitions and behavior remain local to the
 * process; Redis coordinates one turn per identity and persists state/results.
 *
 * It also journals: a command turn's `events` are appended to a per-identity
 * Redis Stream *inside* the same Lua script that writes state and the dedup
 * record, and read back with `events()`. `subscribe()` completes the
 * `ActorEventStore` port by tailing those streams (see
 * `RedisJournalSubscription`): the durable log is the source of truth, live
 * delivery is best effort, and a reconnecting or restarted consumer replays
 * by `seq` — so handlers must be idempotent by `(actor, seq)`.
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_RUNTIME.key},
})
export class RedisActorRuntime implements ActorRuntime, ActorEventStore {
  private readonly definitions = new Map<string, object>();
  private readonly subscriptions = new Set<RedisJournalSubscription>();
  private readonly prefix: string;
  private readonly leaseMs: number;
  private readonly leaseRetryMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly dedupTtlSeconds: number;
  /** Journal cap passed to both `XADD` paths; 0 means "keep everything". */
  private readonly journalMaxLen: number;
  private readonly deliveryDefaults: JournalSubscribeOptions;

  constructor(
    @inject(REDIS_ACTOR_CONNECTIONS)
    private readonly connections: RedisConnectionManager,
    @inject(REDIS_ACTOR_OPTIONS, {optional: true})
    options: RedisActorRuntimeOptions = {},
  ) {
    this.prefix = options.prefix ?? DEFAULT_ACTOR_PREFIX;
    // Resolved and range-checked here, like every other numeric option: a
    // `blockMs` of 0 means "block forever" and a `discoveryIntervalMs` of 0
    // spins the tail loop.
    this.deliveryDefaults = {
      blockMs: positive(options.blockMs ?? 1_000, 'blockMs'),
      discoveryIntervalMs: positive(
        options.discoveryIntervalMs ?? 1_000,
        'discoveryIntervalMs',
      ),
    };
    this.leaseMs = positive(options.leaseMs ?? 30_000, 'leaseMs');
    this.leaseRetryMs = positive(options.leaseRetryMs ?? 25, 'leaseRetryMs');
    this.acquireTimeoutMs = positive(
      options.acquireTimeoutMs ?? 15_000,
      'acquireTimeoutMs',
    );
    this.dedupTtlSeconds = wholeSeconds(
      options.dedupTtlSeconds ?? 86_400,
      'dedupTtlSeconds',
    );
    const maxEvents = options.journal?.maxEventsPerIdentity;
    // Unset is the only way to keep everything; `0` would read as "keep
    // nothing", which no `XADD MAXLEN` can express and nobody wants.
    this.journalMaxLen =
      maxEvents === undefined
        ? 0
        : wholeCount(maxEvents, 'journal.maxEventsPerIdentity');
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
    assertId(id);
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
    assertId(id);
    const actor = {type: definition.name, id};
    // Reads do not take the per-identity lease. COMMIT_TURN's state SET is
    // atomic, so a lone GET observes either the pre- or post-commit value (never
    // a torn one); an absent key returns the computed initial state without
    // persisting it (a read must not mutate Redis).
    return structuredClone(
      await this.readState(definition, actor, this.keys(actor)),
    );
  }

  /**
   * The committed journal for one identity, in commit order. Like `state()`
   * this is a lease-free read: entries only ever appear whole, appended by a
   * commit that already succeeded.
   */
  async events(
    type: string,
    id: string,
  ): Promise<readonly CommittedActorEvent[]> {
    assertActorIdentityPart('type', type);
    assertId(id);
    const actor = {type, id};
    const entries = await this.connections.base.xrange(
      this.keys(actor).log,
      '-',
      '+',
    );
    return entries.map(([, fields]) => toCommittedEvent(actor, fields));
  }

  /**
   * Every identity that has taken a turn under this prefix, from the
   * discovery index (see `indexIdentity`). Delivery needs it because the
   * journal is per identity: without an index, finding the streams to tail
   * would mean scanning the keyspace.
   */
  async identities(): Promise<readonly ActorId[]> {
    const members = await this.connections.base.smembers(this.identityIndexKey);
    return members.map(member => {
      const [type = '', id = ''] = member.split(':');
      return {type: decodeURIComponent(type), id: decodeURIComponent(id)};
    });
  }

  /**
   * Tail every identity journal and hand each committed event to `handler`.
   * Returns an unsubscribe function.
   *
   * Delivery is best effort and at-least-once — see the consumer contract on
   * `ActorEventStore.subscribe`. Each subscription is an independent tail
   * loop with its own connection and its own cursor, and there is no filter
   * between the log and the handler, so every consumer sees every event and
   * dedups by `(actor, seq)` itself. Multiplex several consumers onto one
   * loop rather than subscribing per consumer: that is what
   * `SeatJournalConsumerHost` does for the `seat.journal.consumer` extension
   * point. An async handler is awaited, so a slow consumer only slows its own
   * tail — never the committing turn, which delivery never touches.
   */
  subscribe(
    handler: (event: CommittedActorEvent) => void | Promise<void>,
    options: JournalSubscribeOptions = {},
  ): () => void {
    const source: JournalSource = {
      identities: () => this.identities(),
      logKey: actor => this.keys(actor).log,
      readEntry: (actor, fields) => toCommittedEvent(actor, fields),
    };
    const subscription = new RedisJournalSubscription(
      this.connections,
      source,
      handler,
      {...this.deliveryDefaults, ...options},
    );
    this.subscriptions.add(subscription);
    return () => {
      if (!this.subscriptions.delete(subscription)) return;
      void subscription.close();
    };
  }

  /** Close every live tail loop. Called by the component's stop observer. */
  async stopDelivery(): Promise<void> {
    const live = [...this.subscriptions];
    this.subscriptions.clear();
    await Promise.all(live.map(subscription => subscription.close()));
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

    await this.indexIdentity(actor);
    return this.withLease(actor, definition.deadlineMs, async (lease, keys) => {
      const replay = await this.connections.base.hget(keys.dedup, requestId);
      if (replay !== null) {
        const committed = JSON.parse(replay) as StoredResult;
        if (committed.commandFingerprint !== fingerprint) {
          throw new Error(
            `Actor requestId '${requestId}' was already used for a different command.`,
          );
        }
        return definition.result.parse(committed.result);
      }

      // Held onto (not inlined) so the seat key stamped onto it by `receive`
      // — see ActorCommandContext.seatKeyId — is still readable afterward.
      const ctx: ActorCommandContext = {actor, requestId};
      // The deadline races the **state load and `receive`** — never the
      // commit. Covering the load is what closes the cold-start hole: a
      // hanging `initialState` used to run outside the race entirely, so it
      // produced no `TurnTimeoutError`, no marker, and an `invoke()` promise
      // that never settled. `readState` is inside the raced work for that
      // reason, and the in-process runtimes have always raced their whole
      // action the same way.
      //
      // Stopping short of the commit is what makes the two outcomes mutually
      // exclusive: when the deadline fires, the commit script has not been
      // issued, so a turn can never both commit normally and be recorded as
      // failed. Once the raced work wins, the elapsed-time re-check below is
      // the last deadline gate, and after it the lease-token check inside
      // COMMIT_TURN is the only thing that can still refuse the write. (The
      // corollary: this deadline bounds the seat, not the caller, once the
      // commit script has been issued — a commit that stalls is bounded
      // instead by the renewal cap in `startRenewal`.)
      //
      // Abandoning the load is safe for the same reason abandoning `receive`
      // is. `readState` writes nothing — one `GET` and a `parse` — and the
      // abandoned continuation's value is discarded by the already-settled
      // race, so it never reaches the commit code at all. Nothing it can do
      // later touches Redis, and COMMIT_TURN's token check would refuse it
      // even if something did.
      //
      // `startedAt` is stamped with the race, not at the top of `invoke`:
      // waiting for the seat must never count against a turn's own budget
      // (and both halves of the deadline — the timer and the clock re-check
      // below — must measure the same window).
      //
      // The failed-turn record is written HERE, still inside `withLease`, so
      // no other process can claim the seat and commit between the deadline
      // and the append. Recording it after the release would let the journal
      // report issue order rather than incident order.
      const startedAt = Date.now();
      const turn = await raceTurnDeadline(
        (async () => {
          const state = await this.readState(definition, actor, keys);
          return definition.receive(ctx, structuredClone(state), parsedCommand);
        })(),
        actor,
        requestId,
        definition.deadlineMs,
      ).catch(async (err: unknown) => {
        // Gated on identity, not just type: a `TurnTimeoutError` from a
        // nested actor call passes through this frame, already recorded by
        // the turn that owns it. See `isOwnTurnTimeout`.
        if (isOwnTurnTimeout(err, actor, requestId)) {
          logTimedOutTurn(err);
          await this.recordTimedOutTurn(err);
        }
        throw err;
      });
      // The synchronous half of the same deadline. `raceTurnDeadline` cannot
      // see a `receive` that busy-spins past it — its timer callback is a
      // macrotask, so it has not run yet when an already-settled promise hands
      // control back here. Without this check such a turn would go straight to
      // COMMIT_TURN having plainly missed its deadline, and the renewal timers
      // it also starved would have lapsed the lease, so the caller would get
      // `ActorLeaseLostError` and *no* timeout record at all. Reading the clock
      // gets the same outcome as the async path instead: recorded failed turn,
      // rollback, seat freed. Still inside `withLease`, so the marker lands
      // under this holder's lease (and degrades to a log line if a starved
      // renewal already lost it — see `recordTimedOutTurn`).
      if (turnDeadlinePassed(startedAt, definition.deadlineMs)) {
        const timeout = new TurnTimeoutError(
          actor,
          requestId,
          definition.deadlineMs,
        );
        logTimedOutTurn(timeout);
        await this.recordTimedOutTurn(timeout);
        throw timeout;
      }
      const nextState = definition.state.parse(turn.state);
      const result = definition.result.parse(turn.result);
      if (lease.lost) throw new ActorLeaseLostError(actor);

      const stateRecord: StoredState = {state: nextState};
      const resultRecord: StoredResult = {
        commandFingerprint: fingerprint,
        result,
      };
      const events = turn.events ?? [];
      const committed = await this.evalNumber(
        COMMIT_TURN,
        [keys.lease, keys.state, keys.dedup, keys.log, keys.seq],
        [
          lease.value,
          stringify(stateRecord),
          requestId,
          stringify(resultRecord),
          String(this.dedupTtlSeconds),
          // No key row (no SeatKeyStore bound) journals an empty string —
          // see ActorCommandContext.seatKeyId.
          ctx.seatKeyId ?? '',
          String(this.journalMaxLen),
          String(events.length),
          ...events.map(event => stringify(event)),
        ],
      );
      if (committed === WRONG_TYPES) {
        throw new Error(
          `Redis keys for actor '${actor.type}/${actor.id}' hold unexpected types; nothing was committed.`,
        );
      }
      if (!committed) throw new ActorLeaseLostError(actor);
      return structuredClone(result);
    });
  }

  /**
   * Append the failed turn to this identity's journal.
   *
   * **Called from inside `withLease`, before the release**, so this holder
   * still owns the seat while the record lands: no other process can claim the
   * lease and commit in between, and the journal therefore records incident
   * order rather than issue order. (The lease is genuinely live at that point —
   * renewals cover the whole deadline and the cap tick fires strictly after
   * it.) The append is still un-gated by the token, so a lease lost early to a
   * failed renewal cannot swallow the record.
   *
   * Reachable only from the two deadline paths — the `raceTurnDeadline`
   * rejection and the elapsed-time re-check that catches a synchronous
   * overrun — both of which by construction run before the commit script is
   * ever issued (see the notes in `invoke`). So this can never mark a turn
   * whose commit already landed, and a committed turn can never also be
   * marked failed.
   *
   * The identity may have **no journal yet**: the race covers the state load,
   * so a cold identity whose `initialState` hangs times out before anything
   * has ever been written for it. `APPEND_TURN_FAILURE` handles that — an
   * absent counter `INCRBY`s to 1 (seq 0) and `XADD` creates the stream — so
   * the marker is the identity's first entry rather than a lost record.
   *
   * Best effort in one direction only: if the append itself fails, the caller
   * still gets its `TurnTimeoutError` — a deadline must never surface as some
   * other error — and the lost record is logged.
   */
  private async recordTimedOutTurn(error: TurnTimeoutError): Promise<void> {
    const keys = this.keys(error.actor);
    try {
      const appended = await this.evalNumber(
        APPEND_TURN_FAILURE,
        [keys.log, keys.seq],
        [
          error.requestId,
          // The '' sentinel: the acting seat's key row is stamped on `ctx`
          // only once `receive` returns, and a timed-out turn's never did.
          '',
          stringify(turnTimeoutEvent(error.deadlineMs)),
          String(this.journalMaxLen),
        ],
      );
      if (appended === WRONG_TYPES) {
        throw new Error('the journal key holds an unexpected type');
      }
    } catch (err) {
      log.error(
        'Could not journal the timed-out turn for %s/%s (request %s): %s',
        error.actor.type,
        error.actor.id,
        error.requestId,
        err,
      );
    }
  }

  private async readState<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    actor: ActorId,
    keys: ActorKeys,
  ): Promise<S> {
    const raw = await this.connections.base.get(keys.state);
    if (raw === null) {
      return definition.state.parse(await definition.initialState(actor.id));
    }
    const stored = JSON.parse(raw) as StoredState;
    if (typeof stored !== 'object' || stored === null || !('state' in stored)) {
      throw new Error(
        `Persisted state for actor '${actor.type}/${actor.id}' is invalid.`,
      );
    }
    return definition.state.parse(stored.state);
  }

  private async withLease<T>(
    actor: ActorId,
    deadlineMs: number,
    action: (lease: Lease, keys: ActorKeys) => Promise<T>,
  ): Promise<T> {
    const keys = this.keys(actor);
    const lease = await this.acquire(actor, keys);
    this.startRenewal(lease, keys, deadlineMs);
    try {
      return await action(lease, keys);
    } finally {
      if (lease.timer) clearInterval(lease.timer);
      await this.evalNumber(RELEASE_LEASE, [keys.lease], [lease.value]).catch(
        () => 0,
      );
    }
  }

  private async acquire(actor: ActorId, keys: ActorKeys): Promise<Lease> {
    const token = crypto.randomUUID();
    const deadline = Date.now() + this.acquireTimeoutMs;
    while (Date.now() < deadline) {
      const acquired = await this.connections.base.eval(
        ACQUIRE_LEASE,
        1,
        keys.lease,
        token,
        String(this.leaseMs),
      );
      if (acquired !== null) return {value: token, lost: false};
      await sleep(this.leaseRetryMs);
    }
    throw new ActorLeaseTimeoutError(actor);
  }

  /**
   * Keep this holder's lease alive while its turn runs — but only up to the
   * seat type's deadline.
   *
   * The cap is the distributed half of capability-os#7. Before it, the
   * interval renewed for as long as the turn ran, so a turn that never
   * finished held its seat forever while every other caller failed fast on
   * `acquireTimeoutMs`: a wedge. Now renewals stop once the turn has run for
   * `deadlineMs`, the lease lapses at most `leaseMs` later, and the seat is
   * claimable again no matter what this process does next.
   *
   * The cap counts renewals, which run every `leaseMs / 3` — so it is
   * `deadlineMs / renewalInterval`, not `deadlineMs / leaseMs`. Dividing by
   * `leaseMs` would stop renewing at a third of the deadline and cut long
   * worker turns short.
   *
   * Reaching it also sets `lease.lost`, which flows into the existing
   * `ActorLeaseLostError` path: a turn whose lease is on its way out must not
   * commit, and COMMIT_TURN's own token check would refuse it in any case.
   */
  private startRenewal(
    lease: Lease,
    keys: ActorKeys,
    deadlineMs: number,
  ): void {
    const interval = Math.max(10, Math.floor(this.leaseMs / 3));
    const maxRenewals = Math.max(1, Math.ceil(deadlineMs / interval));
    let renewals = 0;
    lease.timer = setInterval(() => {
      if (++renewals > maxRenewals) {
        if (lease.timer) clearInterval(lease.timer);
        lease.lost = true;
        return;
      }
      void this.evalNumber(
        RENEW_LEASE,
        [keys.lease],
        [lease.value, String(this.leaseMs)],
      )
        .then(renewed => {
          if (!renewed) lease.lost = true;
        })
        .catch(() => {
          lease.lost = true;
        });
    }, interval);
    lease.timer.unref?.();
  }

  /** The one set naming every identity with a journal under this prefix. */
  private get identityIndexKey(): string {
    return `${this.prefix}:identities`;
  }

  /**
   * Re-assert this identity in the discovery index. Runs on **every** turn,
   * before the commit — deliberately not memoized per process.
   *
   * Deliberately **not** part of `COMMIT_TURN` either, because it cannot be:
   * the index is one key for the whole prefix while every commit key carries
   * the `{type:id}` hash tag, so adding it to the script would make the
   * commit cross-slot on Redis Cluster. It does not need to be, because
   * ordering carries the invariant instead — the `SADD` is awaited before the
   * script runs, so a turn that commits an event was preceded by an index
   * write in this same call. The one commit point stays exactly one script;
   * this is an over-approximating hint beside it, not a second half of it
   * (an identity addressed but never committed may be listed, which costs one
   * empty stream in an `XREAD` and delivers nothing).
   *
   * **What holds, precisely:** every committed turn re-writes the entry, so
   * an index lost afterwards (an operator `DEL`, an eviction — this is the
   * cold key while the journal streams stay hot, a failover replaying only
   * part of the window) self-heals on that identity's next turn. It is *not*
   * an inductive guarantee about the past: an identity whose entry is lost
   * and that never takes another turn stays undiscoverable to a **new**
   * subscriber until it does. `events(type, id)` addresses the log directly
   * and is unaffected either way. A memo here would trade exactly that
   * self-healing for one saved round trip per identity per process, next to
   * the two lease round trips every turn already pays — not a trade worth
   * making.
   */
  private async indexIdentity(actor: ActorId): Promise<void> {
    await this.connections.base.sadd(
      this.identityIndexKey,
      `${encodeURIComponent(actor.type)}:${encodeURIComponent(actor.id)}`,
    );
  }

  private keys(actor: ActorId): ActorKeys {
    // The `{type:id}` hash tag is load-bearing: every key below is written by
    // one Lua script, so on Redis Cluster they must share a slot.
    const base = `${this.prefix}:{${encodeURIComponent(actor.type)}:${encodeURIComponent(actor.id)}}`;
    return {
      state: `${base}:state`,
      dedup: `${base}:dedup`,
      lease: `${base}:lease`,
      log: `${base}:log`,
      seq: `${base}:seq`,
    };
  }

  private async evalNumber(
    script: string,
    keys: string[],
    args: string[],
  ): Promise<number> {
    const value = await this.connections.base.eval(
      script,
      keys.length,
      ...keys,
      ...args,
    );
    return Number(value ?? 0);
  }

  private assertRegistered<S, C, R>(
    definition: ActorDefinition<S, C, R>,
  ): void {
    if (this.definitions.get(definition.name) !== definition) {
      throw new Error(`Actor type '${definition.name}' is not registered.`);
    }
  }
}

/** Rebuild one journal entry from a stream entry's flat field/value list. */
function toCommittedEvent(
  actor: ActorId,
  fields: string[],
): CommittedActorEvent {
  const record: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    record[fields[i]!] = fields[i + 1]!;
  }
  const seq = Number(record.seq);
  if (!Number.isInteger(seq)) {
    // Something other than this runtime wrote to the log key. Fail loudly
    // rather than hand back an entry with a NaN position.
    throw new Error(
      `Journal entry for actor '${actor.type}/${actor.id}' has a non-numeric seq.`,
    );
  }
  // seatKeyId is not defaulted here: the commit script always writes the
  // field (empty string when no key row — see the COMMIT_TURN ARGV[6]
  // comment), so a genuinely missing field means a foreign/pre-seat-layer
  // entry, and CommittedActorEventSchema rejects it rather than silently
  // coercing it to the '' sentinel.
  return CommittedActorEventSchema.parse({
    actor,
    seq,
    requestId: record.requestId ?? '',
    seatKeyId: record.seatKeyId,
    event: JSON.parse(record.event ?? 'null') as ActorEvent,
  });
}

function assertId(id: string): void {
  assertActorIdentityPart('id', id);
}

function stringify(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error('Redis actor state and results must be JSON-serializable.');
  }
  return encoded;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}

/**
 * A TTL `EXPIRE` will accept. Rejected here, at construction, because `EXPIRE`
 * runs mid-commit: a fractional or out-of-range TTL would raise after state and
 * the dedup record had already been written, splitting the one commit point.
 */
function wholeSeconds(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DEDUP_TTL_SECONDS) {
    throw new Error(
      `${name} must be a whole number of seconds between 0 and ${MAX_DEDUP_TTL_SECONDS}.`,
    );
  }
  return value;
}

/** A whole positive count. Rejected at construction like every other option. */
function wholeCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
