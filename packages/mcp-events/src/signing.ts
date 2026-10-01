// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Standard Webhooks signing on Web Crypto (runs on every host):
 * `v1,` + base64(HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)), where
 * `secret` is the base64-decoded bytes after `whsec_` and `body` is the raw
 * bytes sent. Off-the-shelf Standard Webhooks verifiers (Svix's libraries)
 * accept these signatures unchanged.
 */

const encoder = new TextEncoder();

/** Decode a `whsec_` secret to its key bytes. */
export function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith('whsec_')) {
    throw new Error('A webhook secret must start with whsec_');
  }
  const bin = atob(secret.slice('whsec_'.length));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh `whsec_` secret from a CSPRNG (32 bytes by default). */
export function generateWebhookSecret(bytes = 32): string {
  if (bytes < 24 || bytes > 64) {
    throw new Error('A webhook secret must be 24–64 bytes');
  }
  return `whsec_${toBase64(crypto.getRandomValues(new Uint8Array(bytes)))}`;
}

/** One `v1,<base64>` signature. */
export async function signatureFor(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${toBase64(new Uint8Array(mac))}`;
}

/**
 * The `webhook-signature` header value: one signature per secret,
 * space-separated — the multi-signature form a secret rotation uses so a
 * receiver holding either secret verifies the delivery.
 */
export async function signWebhook(
  secrets: readonly string[],
  id: string,
  timestamp: number,
  body: string,
): Promise<string> {
  const sigs = await Promise.all(
    secrets.map(s => signatureFor(s, id, timestamp, body)),
  );
  return sigs.join(' ');
}

/** Options for {@link verifyWebhook}. */
export interface VerifyWebhookOptions {
  /** Accepted clock skew, in seconds (default 300, the Standard Webhooks norm). */
  toleranceSec?: number;
  /** Clock, in epoch ms (for tests). */
  now?: () => number;
}

/**
 * Receiver-side verification, for tests and for an AgentBack app receiving
 * webhooks: checks the timestamp window and that **any** `v1,` signature in
 * the header verifies under `secret`, over the raw `body`. Returns `false`
 * rather than throwing.
 */
export async function verifyWebhook(
  secret: string,
  headers: {
    'webhook-id'?: string | null;
    'webhook-timestamp'?: string | null;
    'webhook-signature'?: string | null;
  },
  body: string,
  opts: VerifyWebhookOptions = {},
): Promise<boolean> {
  const id = headers['webhook-id'];
  const ts = Number(headers['webhook-timestamp']);
  const header = headers['webhook-signature'];
  if (!id || !header || !Number.isInteger(ts)) return false;
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSec ?? 300)) return false;
  const expected = await signatureFor(secret, id, ts, body);
  return header
    .split(' ')
    .some(candidate => constantTimeEqual(candidate, expected));
}

/**
 * Compare two strings without an early exit on the first difference. Web
 * Crypto has no `timingSafeEqual`, and a length mismatch reveals only the
 * length, which is public for both signatures and challenge nonces.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
