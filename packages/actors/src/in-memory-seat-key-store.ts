// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope, ContextTags, inject, injectable} from '@agentback/core';
import {
  SEAT_KEY_STORE,
  SEAT_KEY_STORE_KEK,
  type SeatKeyCreateOptions,
  type SeatKeyPublicRecord,
  type SeatKeyRecord,
  type SeatKeyStore,
} from './keys.js';
import {
  decryptSeatPrivateKey,
  encryptSeatPrivateKey,
  generateSeatKeypair,
  normalizeSeatKeyKek,
} from './seat-keys-crypto.js';
import type {ActorId} from './types.js';

function actorIndexKey(actor: ActorId): string {
  // Same encoding as RedisSeatKeyStore's actor-index key (see
  // actors-redis/src/seat-key-store.ts) so both adapters agree on identity.
  // A raw NUL delimiter was used here previously — that makes git treat the
  // file as binary (excluded from diffs/blame/PR review) and a NUL renders
  // as a space in editors, so a whitespace cleanup could silently collide
  // two different actor ids into the same index key.
  return `${encodeURIComponent(actor.type)}:${encodeURIComponent(actor.id)}`;
}

function toPublicRecord(record: SeatKeyRecord): SeatKeyPublicRecord {
  const {encryptedPrivateKey: _encryptedPrivateKey, ...pub} = record;
  return pub;
}

/**
 * Single-process reference adapter for the `seat.keyStore` port. Private
 * keys are encrypted at rest under the injected KEK and only ever leave
 * this store once, via `takeCustody()`.
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: SEAT_KEY_STORE.key},
})
export class InMemorySeatKeyStore implements SeatKeyStore {
  private readonly recordsByKeyId = new Map<string, SeatKeyRecord>();
  private readonly keyIdByActor = new Map<string, string>();
  private readonly kek: Buffer;

  constructor(@inject(SEAT_KEY_STORE_KEK) kek: Buffer | string) {
    this.kek = normalizeSeatKeyKek(kek);
  }

  async create(
    actor: ActorId,
    options: SeatKeyCreateOptions = {},
  ): Promise<SeatKeyPublicRecord> {
    // No `await` runs between this check and the writes below, so two
    // concurrent calls for the same actor cannot interleave (Node's single
    // thread runs this synchronous span to completion before yielding) — the
    // second call always observes the first's write. A distributed adapter
    // needs an explicit atomic claim; see RedisSeatKeyStore.
    const existingKeyId = this.keyIdByActor.get(actorIndexKey(actor));
    if (existingKeyId) return this.publicRecord(existingKeyId)!;

    const keypair = generateSeatKeypair();
    const record: SeatKeyRecord = {
      seatKeyId: keypair.seatKeyId,
      ownerAccountId: options.ownerAccountId,
      publicKey: keypair.publicKey,
      encryptedPrivateKey: encryptSeatPrivateKey(keypair.privateKey, this.kek),
      exportedAt: null,
    };
    this.recordsByKeyId.set(record.seatKeyId, record);
    this.keyIdByActor.set(actorIndexKey(actor), record.seatKeyId);
    return toPublicRecord(record);
  }

  async get(seatKeyId: string): Promise<SeatKeyPublicRecord | undefined> {
    return this.publicRecord(seatKeyId);
  }

  async getByActor(actor: ActorId): Promise<SeatKeyPublicRecord | undefined> {
    const seatKeyId = this.keyIdByActor.get(actorIndexKey(actor));
    return seatKeyId ? this.publicRecord(seatKeyId) : undefined;
  }

  async takeCustody(seatKeyId: string): Promise<string> {
    const record = this.recordsByKeyId.get(seatKeyId);
    if (!record) throw new Error(`Unknown seat key '${seatKeyId}'.`);
    if (record.exportedAt) {
      throw new Error(`Seat key '${seatKeyId}' has already been exported.`);
    }
    // Decrypt before the mark, never after: a wrong or rotated KEK must not
    // consume the one-shot on its way to throwing, or the escape hatch fails
    // forever in exactly the case it exists for. (Both statements below run in
    // one synchronous span, so the ordering costs no atomicity here; see
    // `RedisSeatKeyStore.takeCustody` for the distributed version.)
    const privateKey = decryptSeatPrivateKey(
      record.encryptedPrivateKey,
      this.kek,
    );
    this.recordsByKeyId.set(seatKeyId, {
      ...record,
      exportedAt: new Date().toISOString(),
    });
    return privateKey.toString('hex');
  }

  private publicRecord(seatKeyId: string): SeatKeyPublicRecord | undefined {
    const record = this.recordsByKeyId.get(seatKeyId);
    return record ? toPublicRecord(record) : undefined;
  }
}
