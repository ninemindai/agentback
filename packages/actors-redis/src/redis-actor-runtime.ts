// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ACTOR_RUNTIME,
  actorCommandFingerprint,
  type ActorDefinition,
  type ActorId,
  type ActorInvokeOptions,
  type ActorRef,
  type ActorRuntime,
} from '@agentback/actors';
import {BindingScope, ContextTags, inject, injectable} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {REDIS_ACTOR_CONNECTIONS, REDIS_ACTOR_OPTIONS} from './keys.js';

const ACQUIRE_LEASE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return nil end
local fence = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1] .. ':' .. fence, 'PX', ARGV[2])
return tostring(fence)
`;

const RENEW_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

const RELEASE_LEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const COMMIT_TURN = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[3], ARGV[4])
local ttl = tonumber(ARGV[5])
if ttl and ttl > 0 then redis.call('EXPIRE', KEYS[3], ttl) end
return 1
`;

const COMMIT_INITIAL_STATE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SET', KEYS[2], ARGV[2])
end
return 1
`;

interface StoredState {
  version: number;
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
  fence: string;
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
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_RUNTIME.key},
})
export class RedisActorRuntime implements ActorRuntime {
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
    this.dedupTtlSeconds = nonNegative(
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
    return this.withLease(actor, async (lease, keys) => {
      const stored = await this.readState(definition, actor, keys);
      if (!stored.persisted) {
        const committed = await this.evalNumber(
          COMMIT_INITIAL_STATE,
          [keys.lease, keys.state],
          [lease.value, stringify({version: 0, state: stored.state})],
        );
        if (!committed) throw new ActorLeaseLostError(actor);
      }
      return structuredClone(stored.state);
    });
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

      const stored = await this.readState(definition, actor, keys);
      const workingState = structuredClone(stored.state);
      const turn = await definition.receive(
        {actor, requestId},
        workingState,
        parsedCommand,
      );
      const nextState = definition.state.parse(turn.state);
      const result = definition.result.parse(turn.result);
      if (lease.lost) throw new ActorLeaseLostError(actor);

      const stateRecord: StoredState = {
        version: stored.version + 1,
        state: nextState,
      };
      const resultRecord: StoredResult = {
        commandFingerprint: fingerprint,
        result,
      };
      const committed = await this.evalNumber(
        COMMIT_TURN,
        [keys.lease, keys.state, keys.dedup],
        [
          lease.value,
          stringify(stateRecord),
          requestId,
          stringify(resultRecord),
          String(this.dedupTtlSeconds),
        ],
      );
      if (!committed) throw new ActorLeaseLostError(actor);
      return structuredClone(result);
    });
  }

  private async readState<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    actor: ActorId,
    keys: ActorKeys,
  ): Promise<{state: S; version: number; persisted: boolean}> {
    const raw = await this.connections.base.get(keys.state);
    if (raw === null) {
      return {
        state: definition.state.parse(await definition.initialState(actor.id)),
        version: 0,
        persisted: false,
      };
    }
    const stored = JSON.parse(raw) as StoredState;
    if (
      !Number.isSafeInteger(stored.version) ||
      stored.version < 0 ||
      !('state' in stored)
    ) {
      throw new Error(
        `Persisted state for actor '${actor.type}/${actor.id}' is invalid.`,
      );
    }
    return {
      state: definition.state.parse(stored.state),
      version: stored.version,
      persisted: true,
    };
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
      const fence = await this.connections.base.eval(
        ACQUIRE_LEASE,
        2,
        keys.lease,
        keys.fence,
        token,
        String(this.leaseMs),
      );
      if (fence !== null)
        return {value: `${token}:${String(fence)}`, lost: false};
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
    const base = `${this.prefix}:{${encodeURIComponent(actor.type)}:${encodeURIComponent(actor.id)}}`;
    return {
      state: `${base}:state`,
      dedup: `${base}:dedup`,
      lease: `${base}:lease`,
      fence: `${base}:fence`,
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

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
