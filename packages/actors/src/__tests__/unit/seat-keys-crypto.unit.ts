// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createECDH, randomBytes} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {
  decryptSeatPrivateKey,
  encryptSeatPrivateKey,
  generateSeatKeypair,
} from '../../seat-keys-crypto.js';

function derivePublicKeyHex(privateKey: Buffer): string {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(privateKey);
  return ecdh.getPublicKey(null, 'compressed').toString('hex');
}

describe('generateSeatKeypair', () => {
  it('always returns a 32-byte private key (pins the zero-pad fix)', () => {
    // ECDH.getPrivateKey() does not zero-pad — about 1 in 256 keys comes
    // back shorter than 32 bytes. Enough iterations to make that likely to
    // surface if the padding regresses.
    for (let i = 0; i < 200; i++) {
      expect(generateSeatKeypair().privateKey).toHaveLength(32);
    }
  });

  it('derives seatKeyId as the x-only part of the compressed publicKey', () => {
    for (let i = 0; i < 25; i++) {
      const {seatKeyId, publicKey} = generateSeatKeypair();
      expect(publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
      expect(publicKey.slice(2)).toBe(seatKeyId);
    }
  });

  it('the returned privateKey actually derives the returned publicKey on the curve', () => {
    for (let i = 0; i < 25; i++) {
      const {publicKey, privateKey} = generateSeatKeypair();
      expect(derivePublicKeyHex(privateKey)).toBe(publicKey);
    }
  });
});

describe('encryptSeatPrivateKey / decryptSeatPrivateKey', () => {
  it('round-trips a private key under the same KEK', () => {
    const kek = randomBytes(32);
    const {privateKey} = generateSeatKeypair();

    const encrypted = encryptSeatPrivateKey(privateKey, kek);
    expect(decryptSeatPrivateKey(encrypted, kek)).toEqual(privateKey);
  });

  it('uses a random IV — encrypting the same key twice yields different ciphertext', () => {
    const kek = randomBytes(32);
    const {privateKey} = generateSeatKeypair();

    const first = encryptSeatPrivateKey(privateKey, kek);
    const second = encryptSeatPrivateKey(privateKey, kek);

    expect(first).not.toBe(second);
    expect(decryptSeatPrivateKey(first, kek)).toEqual(privateKey);
    expect(decryptSeatPrivateKey(second, kek)).toEqual(privateKey);
  });

  it('fails to decrypt under the wrong KEK', () => {
    const {privateKey} = generateSeatKeypair();
    const encrypted = encryptSeatPrivateKey(privateKey, randomBytes(32));

    expect(() => decryptSeatPrivateKey(encrypted, randomBytes(32))).toThrow();
  });

  it('fails GCM auth-tag verification when a ciphertext byte is flipped', () => {
    const kek = randomBytes(32);
    const {privateKey} = generateSeatKeypair();
    const raw = Buffer.from(encryptSeatPrivateKey(privateKey, kek), 'base64');

    // Layout is iv(12) || authTag(16) || ciphertext(...); flip the last byte.
    raw[raw.length - 1] ^= 0xff;

    expect(() => decryptSeatPrivateKey(raw.toString('base64'), kek)).toThrow();
  });

  it('fails GCM auth-tag verification when an auth-tag byte is flipped', () => {
    const kek = randomBytes(32);
    const {privateKey} = generateSeatKeypair();
    const raw = Buffer.from(encryptSeatPrivateKey(privateKey, kek), 'base64');

    // Auth tag occupies bytes [12, 28).
    raw[12] ^= 0xff;

    expect(() => decryptSeatPrivateKey(raw.toString('base64'), kek)).toThrow();
  });
});
