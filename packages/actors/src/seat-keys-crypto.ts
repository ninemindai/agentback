// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  randomBytes,
} from 'node:crypto';

/** A freshly generated, never-persisted secp256k1 keypair. Nothing here ever signs. */
export interface GeneratedSeatKeypair {
  /**
   * The 32-byte X coordinate of the compressed public key, lowercase hex
   * (Nostr convention: the pubkey IS the identity).
   */
  seatKeyId: string;
  /** The 33-byte compressed public key, lowercase hex. */
  publicKey: string;
  /** The 32-byte raw private key. */
  privateKey: Buffer;
}

const PRIVATE_KEY_LENGTH = 32;

/**
 * Generate a dormant secp256k1 keypair, Nostr-compatible. Never signs,
 * never persists — the caller decides what, if anything, to do with it.
 */
export function generateSeatKeypair(): GeneratedSeatKeypair {
  const ecdh = createECDH('secp256k1');
  ecdh.generateKeys();
  const publicKey = ecdh.getPublicKey(null, 'compressed') as Buffer;
  // `ECDH.getPrivateKey()` does not zero-pad: about 1 in 256 keys comes back
  // shorter than 32 bytes (a leading zero byte was dropped). Left-pad so
  // every private key round-trips through encrypt/decrypt at a fixed length.
  const privateKey = leftPad(
    ecdh.getPrivateKey() as Buffer,
    PRIVATE_KEY_LENGTH,
  );
  return {
    seatKeyId: publicKey.subarray(1).toString('hex'),
    publicKey: publicKey.toString('hex'),
    privateKey,
  };
}

function leftPad(buffer: Buffer, length: number): Buffer {
  if (buffer.length === length) return buffer;
  if (buffer.length > length) {
    throw new Error(
      `Generated secp256k1 private key is longer than ${length} bytes.`,
    );
  }
  return Buffer.concat([Buffer.alloc(length - buffer.length), buffer]);
}

const KEK_LENGTH = 32; // AES-256
const IV_LENGTH = 12; // GCM standard nonce size
const AUTH_TAG_LENGTH = 16;

/** Normalize a KEK (raw bytes or a base64 string) and validate its length. */
export function normalizeSeatKeyKek(kek: Buffer | string): Buffer {
  const buffer = typeof kek === 'string' ? Buffer.from(kek, 'base64') : kek;
  if (buffer.length !== KEK_LENGTH) {
    throw new Error(
      `Seat key store KEK must decode to exactly ${KEK_LENGTH} bytes for AES-256-GCM (got ${buffer.length}).`,
    );
  }
  return buffer;
}

/**
 * Read the seat key store's KEK from an env var (base64-encoded 32 bytes).
 * A missing or mis-sized value is a hard error, never a silent fallback.
 */
export function seatKeyKekFromEnv(name = 'SEAT_KEY_STORE_KEK'): Buffer {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `Missing required env var '${name}' for the seat key store's encryption key.`,
    );
  }
  return normalizeSeatKeyKek(raw);
}

/**
 * Encrypt a private key at rest under the KEK. Returns base64 of
 * `iv || authTag || ciphertext`.
 */
export function encryptSeatPrivateKey(privateKey: Buffer, kek: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Decrypt a private key produced by `encryptSeatPrivateKey`. */
export function decryptSeatPrivateKey(encrypted: string, kek: Buffer): Buffer {
  const raw = Buffer.from(encrypted, 'base64');
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
