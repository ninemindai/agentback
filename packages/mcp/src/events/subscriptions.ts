// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {stableStringify} from '@agentback/common';
import {securityId, type UserProfile} from '@agentback/security';
import {ProtocolError, ProtocolErrorCode} from '@modelcontextprotocol/server';
import {assertJson} from '../fragments.js';
import type {McpEventsConfig} from '../types.js';

/** {@link McpEventsConfig} with every default applied. */
export type ResolvedEventsConfig = Required<McpEventsConfig>;

export const DEFAULT_EVENTS_CONFIG: ResolvedEventsConfig = {
  defaultTtlMs: 60 * 60_000,
  minTtlMs: 60_000,
  maxTtlMs: 24 * 60 * 60_000,
  allowNoExpiry: false,
  maxSubscriptionsPerPrincipal: 100,
  secretRotationGraceMs: 5 * 60_000,
  verificationTtlMs: 60 * 60_000,
  trustedCallbackOrigins: [],
};

export function resolveEventsConfig(
  cfg: McpEventsConfig | undefined,
): ResolvedEventsConfig {
  const out = {...DEFAULT_EVENTS_CONFIG, ...(cfg ?? {})};
  for (const key of [
    'defaultTtlMs',
    'minTtlMs',
    'maxTtlMs',
    'maxSubscriptionsPerPrincipal',
    'secretRotationGraceMs',
    'verificationTtlMs',
  ] as const) {
    const v = out[key];
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(
        `MCPServerConfig.events.${key} must be a number >= 0 (got ${String(v)})`,
      );
    }
  }
  if (out.minTtlMs > out.maxTtlMs) {
    throw new Error(
      `MCPServerConfig.events.minTtlMs (${out.minTtlMs}) exceeds maxTtlMs (${out.maxTtlMs})`,
    );
  }
  for (const origin of out.trustedCallbackOrigins) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== origin) {
      throw new Error(
        `MCPServerConfig.events.trustedCallbackOrigins: ${JSON.stringify(
          origin,
        )} is not an https origin (scheme://host[:port], no path)`,
      );
    }
  }
  return out;
}

/** The validated, normalized params of `events/subscribe`. */
export interface SubscribeParams {
  name: string;
  arguments: Record<string, unknown>;
  url: string;
  secret: string;
  /** `undefined` = server default; `null` = no expiry requested. */
  ttlMs: number | null | undefined;
}

/** The validated params of `events/unsubscribe`. */
export interface UnsubscribeParams {
  name: string;
  arguments: Record<string, unknown>;
  url: string;
}

/** `-32602` with a stable message; never echoes a secret. */
export function invalidParams(message: string): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InvalidParams, message);
}

/** Parse `events/subscribe` params, throwing `-32602` on anything malformed. */
export function parseSubscribeParams(raw: unknown): {
  params: SubscribeParams;
  mode: unknown;
} {
  const p = record(raw, 'params');
  const name = eventName(p.name);
  const args = argumentsOf(p.arguments);
  const delivery = record(p.delivery, 'delivery');
  const url = callbackUrl(delivery.url);
  const secret = delivery.secret;
  if (typeof secret !== 'string' || !isWebhookSecret(secret)) {
    throw invalidParams(
      'delivery.secret must be a Standard Webhooks secret: "whsec_" followed ' +
        'by base64 of 24–64 random bytes',
    );
  }
  let ttlMs: number | null | undefined;
  if (p.ttlMs === null) ttlMs = null;
  else if (p.ttlMs !== undefined) {
    if (
      typeof p.ttlMs !== 'number' ||
      !Number.isSafeInteger(p.ttlMs) ||
      p.ttlMs < 0
    ) {
      throw invalidParams('ttlMs must be a non-negative integer or null');
    }
    ttlMs = p.ttlMs;
  }
  return {
    params: {name, arguments: args, url, secret, ttlMs},
    mode: delivery.mode,
  };
}

/** Parse `events/unsubscribe` params, throwing `-32602` on anything malformed. */
export function parseUnsubscribeParams(raw: unknown): UnsubscribeParams {
  const p = record(raw, 'params');
  const delivery = record(p.delivery, 'delivery');
  return {
    name: eventName(p.name),
    arguments: argumentsOf(p.arguments),
    url: callbackUrl(delivery.url),
  };
}

/**
 * True for a Standard Webhooks symmetric secret: `whsec_` + base64 of 24–64
 * bytes. Decoded with `atob`, which every supported host has.
 */
export function isWebhookSecret(secret: string): boolean {
  const m = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret);
  if (!m) return false;
  let bytes: number;
  try {
    bytes = atob(m[1]!).length;
  } catch {
    return false;
  }
  return bytes >= 24 && bytes <= 64;
}

/**
 * The subscription's deterministic routing handle: `sub_` + 128 bits of
 * SHA-256 over the canonical key `(principal, url, name, arguments)`.
 * `arguments` is canonical JSON, so key order never splits a subscription.
 * Web Crypto, so it runs on every host.
 */
export async function subscriptionId(
  principal: string,
  url: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const key = stableStringify([principal, url, name, args]);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(key),
  );
  const hex = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `sub_${hex.slice(0, 32)}`;
}

/**
 * The TTL grant. Omitted ⇒ the default; a number ⇒ clamped into
 * `[minTtlMs, maxTtlMs]` (a clamp is self-announcing through
 * `refreshBefore`, never an error); `null` ⇒ no expiry only when
 * `allowNoExpiry` is configured — a server that cannot persist across a
 * restart must not grant it — otherwise the default.
 */
export function grantTtl(
  requested: number | null | undefined,
  cfg: ResolvedEventsConfig,
  now: number,
): {expiresAt: number | null; refreshBefore: string | null} {
  if (requested === null && cfg.allowNoExpiry) {
    return {expiresAt: null, refreshBefore: null};
  }
  const ttl =
    typeof requested === 'number'
      ? Math.min(Math.max(requested, cfg.minTtlMs), cfg.maxTtlMs)
      : Math.min(Math.max(cfg.defaultTtlMs, cfg.minTtlMs), cfg.maxTtlMs);
  const expiresAt = now + ttl;
  return {expiresAt, refreshBefore: new Date(expiresAt).toISOString()};
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidParams(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function eventName(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams('name must be a non-empty string');
  }
  return value;
}

function argumentsOf(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const args = record(value, 'arguments');
  // Identity is canonical JSON, so the arguments must be plain JSON.
  try {
    assertJson(args, 'arguments');
  } catch (err) {
    throw invalidParams((err as Error).message);
  }
  return args;
}

function callbackUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw invalidParams(
      'delivery.url must be a URL of at most 2048 characters',
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidParams('delivery.url is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw invalidParams('delivery.url must use https');
  }
  if (url.username || url.password) {
    throw invalidParams('delivery.url must not carry credentials');
  }
  if (url.hash) throw invalidParams('delivery.url must not have a fragment');
  // Normalized (lower-case host, default port dropped), so spellings of one
  // URL are one identity, one verification and one delivery target.
  return url.href;
}

/**
 * The JSON-only claims of a profile, for {@link EventSubscription.profile}:
 * its string-keyed properties (the `securityId` symbol is the subscription's
 * `principal`). Anything that is not plain JSON is dropped.
 */
export function toProfile(user: UserProfile): Record<string, unknown> {
  try {
    const json = JSON.parse(JSON.stringify(user)) as unknown;
    return json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  } catch {
    // A cyclic or BigInt-bearing profile keeps only what authorization reads.
    const {roles, scopes} = user as {roles?: unknown; scopes?: unknown};
    return JSON.parse(JSON.stringify({roles, scopes})) as Record<
      string,
      unknown
    >;
  }
}

/** Rebuild the subscriber's `UserProfile` from a stored subscription. */
export function subscriberProfile(sub: {
  principal: string;
  profile: Readonly<Record<string, unknown>>;
}): UserProfile {
  return {...sub.profile, [securityId]: sub.principal} as UserProfile;
}
