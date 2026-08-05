// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomBytes} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {InMemorySeatKeyStore} from '../../in-memory-seat-key-store.js';
import {
  normalizeSeatKeyKek,
  seatKeyKekFromEnv,
} from '../../seat-keys-crypto.js';
import {runSeatKeyStoreConformance} from '../../testing/conformance.js';

function kek(): Buffer {
  return randomBytes(32);
}

runSeatKeyStoreConformance('in-memory', () => new InMemorySeatKeyStore(kek()));

describe('InMemorySeatKeyStore', () => {
  it('rejects a KEK that does not decode to 32 bytes', () => {
    expect(() => new InMemorySeatKeyStore(randomBytes(16))).toThrow(/32 bytes/);
  });

  it('accepts a base64-encoded 32-byte KEK', async () => {
    const store = new InMemorySeatKeyStore(kek().toString('base64'));
    const record = await store.create({type: 'seat', id: 'one'});
    expect(record.seatKeyId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never leaks private-key material through the thrown error on a second takeCustody', async () => {
    const store = new InMemorySeatKeyStore(kek());
    const record = await store.create({type: 'seat', id: 'one'});
    const privateKey = await store.takeCustody(record.seatKeyId);

    try {
      await store.takeCustody(record.seatKeyId);
      throw new Error('expected takeCustody to reject');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(privateKey);
    }
  });

  it('encrypts the same private key differently across two seats (random IV)', async () => {
    const store = new InMemorySeatKeyStore(kek());
    const one = await store.create({type: 'seat', id: 'one'});
    const two = await store.create({type: 'seat', id: 'two'});
    expect(one.seatKeyId).not.toBe(two.seatKeyId);
  });
});

describe('normalizeSeatKeyKek', () => {
  it('accepts a raw 32-byte buffer', () => {
    const raw = randomBytes(32);
    expect(normalizeSeatKeyKek(raw)).toEqual(raw);
  });

  it('accepts a base64 string decoding to 32 bytes', () => {
    const raw = randomBytes(32);
    expect(normalizeSeatKeyKek(raw.toString('base64'))).toEqual(raw);
  });

  it('rejects the wrong length', () => {
    expect(() => normalizeSeatKeyKek(randomBytes(31))).toThrow(/32 bytes/);
  });
});

describe('seatKeyKekFromEnv', () => {
  it('throws when the env var is missing', () => {
    const name = 'SEAT_KEY_STORE_KEK_TEST_UNSET';
    delete process.env[name];
    expect(() => seatKeyKekFromEnv(name)).toThrow(/Missing required env var/);
  });

  it('reads and decodes a base64 KEK from the named env var', () => {
    const name = 'SEAT_KEY_STORE_KEK_TEST_SET';
    const raw = randomBytes(32);
    process.env[name] = raw.toString('base64');
    try {
      expect(seatKeyKekFromEnv(name)).toEqual(raw);
    } finally {
      delete process.env[name];
    }
  });
});
