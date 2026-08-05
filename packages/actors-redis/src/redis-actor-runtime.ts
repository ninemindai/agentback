// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ACTOR_RUNTIME,
  actorCommandFingerprint,
  CommittedActorEventSchema,
  type ActorCommandContext,
  type ActorDefinition,
  type ActorEvent,
  type ActorEventReader,
  type ActorId,
  type ActorInvokeOptions,
  type ActorRef,
  type ActorRuntime,
  type CommittedActorEvent,
} from '@agentback/actors';
import {BindingScope, ContextTags, inject, injectable} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {REDIS_ACTOR_CONNECTIONS, REDIS_ACTOR_OPTIONS} from './keys.js';

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
// KEYS: lease, state, dedup, log, seq   ARGV: token, state, requestId, result,
// dedupTtl, seatKeyId, eventCount, event JSON…
const COMMIT_TURN = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local function wrongType(key, want)
  local kind = redis.call('TYPE', key)['ok']
  return kind ~= 'none' and kind ~= want
end
local count = tonumber(ARGV[7])
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
  redis.call('XADD', KEYS[4], '*',
    'seq', tostring(base + i - 1),
    'requestId', ARGV[3],
    'seatKeyId', ARGV[6],
    'event', ARGV[7 + i])
end
return 1
`;

/** COMMIT_TURN aborted: a target key exists holding an unexpected type. */
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

export interface RedisActorRuntimeOptions {
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
 * record, and read back with `events()`. In-process delivery (`subscribe`) is
 * not offered here — a durable log is read, or tailed by a consumer, rather
 * than pushed to callbacks in one process.
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_RUNTIME.key},
})
export class RedisActorRuntime implements ActorRuntime, ActorEventReader {
  private readonly definitions = new Map<string, object>();
  private readonly prefix: string;
  private readonly leaseMs: number;
  private readonly leaseRetryMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly dedupTtlSeconds: number;

  constructor(
    @inject(REDIS_ACTOR_CONNECTIONS)
    private readonly connections: RedisConnectionManager,
    @inject(REDIS_ACTOR_OPTIONS, {optional: true})
    options: RedisActorRuntimeOptions = {},
  ) {
    this.prefix = options.prefix ?? 'agentback:actors';
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
    assertId(id);
    const actor = {type, id};
    const entries = await this.connections.base.xrange(
      this.keys(actor).log,
      '-',
      '+',
    );
    return entries.map(([, fields]) => toCommittedEvent(actor, fields));
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

    return this.withLease(actor, async (lease, keys) => {
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

      const state = await this.readState(definition, actor, keys);
      const workingState = structuredClone(state);
      // Held onto (not inlined) so the seat key stamped onto it by `receive`
      // — see ActorCommandContext.seatKeyId — is still readable afterward.
      const ctx: ActorCommandContext = {actor, requestId};
      const turn = await definition.receive(ctx, workingState, parsedCommand);
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
    action: (lease: Lease, keys: ActorKeys) => Promise<T>,
  ): Promise<T> {
    const keys = this.keys(actor);
    const lease = await this.acquire(actor, keys);
    this.startRenewal(lease, keys);
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

  private startRenewal(lease: Lease, keys: ActorKeys): void {
    const interval = Math.max(10, Math.floor(this.leaseMs / 3));
    lease.timer = setInterval(() => {
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
  if (!id.trim()) throw new Error('Actor id must not be empty.');
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
