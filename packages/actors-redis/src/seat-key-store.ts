// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  SEAT_KEY_STORE,
  SEAT_KEY_STORE_KEK,
  decryptSeatPrivateKey,
  encryptSeatPrivateKey,
  generateSeatKeypair,
  normalizeSeatKeyKek,
  type ActorId,
  type SeatKeyCreateOptions,
  type SeatKeyPublicRecord,
  type SeatKeyRecord,
  type SeatKeyStore,
} from '@agentback/actors';
import {BindingScope, ContextTags, inject, injectable} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {REDIS_ACTOR_CONNECTIONS, SEAT_KEY_STORE_OPTIONS} from './keys.js';

// Atomic claim: the actor→seatKeyId index is the sole mutual-exclusion guard,
// same discipline as the lease scripts in redis-actor-runtime.ts. If another
// caller already claimed this actor, the keypair generated locally is
// discarded (never persisted, never logged) and the winner's record is
// returned instead.
const CLAIM_SEAT_KEY = `
local existing = redis.call('GET', KEYS[1])
if existing then return existing end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return ARGV[1]
`;

// Atomic export: GET-then-SET is not enough (two concurrent takeCustody calls
// could both observe exportedAt == null), so the check-and-mark runs as one
// Lua script. `cjson.decode('null')` is the sentinel `cjson.null`, not Lua
// `nil` — it is truthy, so the guard must check for it explicitly.
const TAKE_CUSTODY = `
local raw = redis.call('GET', KEYS[1])
if not raw then return redis.error_reply('seat_key_not_found') end
local record = cjson.decode(raw)
if record.exportedAt ~= nil and record.exportedAt ~= cjson.null then
  return redis.error_reply('seat_key_already_exported')
end
record.exportedAt = ARGV[1]
redis.call('SET', KEYS[1], cjson.encode(record))
return raw
`;

export interface RedisSeatKeyStoreOptions {
  /** Redis key prefix. Default `agentback:actors:seatKeys`. */
  prefix?: string;
}

/**
 * Redis-backed adapter for the `seat.keyStore` port. Shares the actors
 * runtime's connection manager; private keys are encrypted at rest under the
 * injected KEK and only ever leave this store once, via `takeCustody()`.
 *
 * Cluster note: unlike `RedisActorRuntime` (whose per-identity keys share one
 * hash tag by design), `create()`'s Lua script spans an actor-indexed key and
 * a seatKeyId-indexed record key, which are not guaranteed to land on the
 * same slot — `get(seatKeyId)` must stay reachable without knowing the owning
 * actor, which rules out co-locating them under one tag. Verified against
 * standalone Redis (no slot restriction); a Redis Cluster deployment needs a
 * cluster-aware revision of `create()` before this adapter is safe there.
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: SEAT_KEY_STORE.key},
})
export class RedisSeatKeyStore implements SeatKeyStore {
  private readonly prefix: string;
  private readonly kek: Buffer;

  constructor(
    @inject(REDIS_ACTOR_CONNECTIONS)
    private readonly connections: RedisConnectionManager,
    @inject(SEAT_KEY_STORE_KEK) kek: Buffer | string,
    @inject(SEAT_KEY_STORE_OPTIONS, {optional: true})
    options: RedisSeatKeyStoreOptions = {},
  ) {
    this.kek = normalizeSeatKeyKek(kek);
    this.prefix = options.prefix ?? 'agentback:actors:seatKeys';
  }

  async create(
    actor: ActorId,
    options: SeatKeyCreateOptions = {},
  ): Promise<SeatKeyPublicRecord> {
    const keypair = generateSeatKeypair();
    const candidate: SeatKeyRecord = {
      seatKeyId: keypair.seatKeyId,
      ownerAccountId: options.ownerAccountId,
      publicKey: keypair.publicKey,
      encryptedPrivateKey: encryptSeatPrivateKey(keypair.privateKey, this.kek),
      exportedAt: null,
    };

    const winningSeatKeyId = (await this.connections.base.eval(
      CLAIM_SEAT_KEY,
      2,
      this.actorIndexKey(actor),
      this.recordKey(candidate.seatKeyId),
      candidate.seatKeyId,
      JSON.stringify(candidate),
    )) as string;

    if (winningSeatKeyId === candidate.seatKeyId) {
      return toPublicRecord(candidate);
    }
    // Lost the race: someone else's keypair won. Ours was never persisted.
    const winner = await this.get(winningSeatKeyId);
    if (!winner) {
      throw new Error(
        `Seat key claim for '${actor.type}/${actor.id}' resolved to a missing record.`,
      );
    }
    return winner;
  }

  async get(seatKeyId: string): Promise<SeatKeyPublicRecord | undefined> {
    const raw = await this.connections.base.get(this.recordKey(seatKeyId));
    return raw ? toPublicRecord(JSON.parse(raw) as SeatKeyRecord) : undefined;
  }

  async getByActor(actor: ActorId): Promise<SeatKeyPublicRecord | undefined> {
    const seatKeyId = await this.connections.base.get(
      this.actorIndexKey(actor),
    );
    return seatKeyId ? this.get(seatKeyId) : undefined;
  }

  async takeCustody(seatKeyId: string): Promise<string> {
    let raw: string;
    try {
      raw = (await this.connections.base.eval(
        TAKE_CUSTODY,
        1,
        this.recordKey(seatKeyId),
        new Date().toISOString(),
      )) as string;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('seat_key_not_found')) {
        throw new Error(`Unknown seat key '${seatKeyId}'.`);
      }
      if (message.includes('seat_key_already_exported')) {
        throw new Error(`Seat key '${seatKeyId}' has already been exported.`);
      }
      throw err;
    }
    const record = JSON.parse(raw) as SeatKeyRecord;
    return decryptSeatPrivateKey(record.encryptedPrivateKey, this.kek).toString(
      'hex',
    );
  }

  private actorIndexKey(actor: ActorId): string {
    return `${this.prefix}:byActor:${encodeURIComponent(actor.type)}:${encodeURIComponent(actor.id)}`;
  }

  private recordKey(seatKeyId: string): string {
    return `${this.prefix}:record:${seatKeyId}`;
  }
}

function toPublicRecord(record: SeatKeyRecord): SeatKeyPublicRecord {
  const {encryptedPrivateKey: _encryptedPrivateKey, ...pub} = record;
  return pub;
}
