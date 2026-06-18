// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createHash} from 'node:crypto';
import {inject} from '@agentback/context';
import createError from 'http-errors';
import {OAuth2Bindings} from './keys.js';
import type {
  FetchLike,
  IntrospectionResponse,
  OAuth2IntrospectionConfig,
} from './types.js';

interface CacheEntry {
  claims: IntrospectionResponse;
  /** Wall-clock ms after which this entry is stale. */
  expiresAt: number;
}

/**
 * Validates opaque OAuth2 access tokens against an authorization server's
 * RFC 7662 token-introspection endpoint. Opaque tokens carry no verifiable
 * signature, so the only way to learn whether one is live is to ask the AS —
 * which means a network round-trip per token. This service owns that call and
 * the resource server's client authentication to the endpoint.
 *
 * Error mapping is deliberate:
 *   - the token is well-formed but the AS says it is dead → 401 (the *caller*
 *     is unauthenticated);
 *   - the endpoint is unreachable or errors → 503 (a *dependency* failed, not
 *     the caller's fault) — never swallow this into a 401, which would mask an
 *     AS outage as "bad token".
 */
export class OAuth2IntrospectionService {
  constructor(
    @inject(OAuth2Bindings.CONFIG) private config: OAuth2IntrospectionConfig,
    @inject(OAuth2Bindings.FETCH, {optional: true})
    private fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private now: () => number = () => Date.now(),
  ) {}

  /** SHA-256 token cache. The raw token is never stored — only its digest. */
  private readonly cache = new Map<string, CacheEntry>();

  async introspect(token: string): Promise<IntrospectionResponse> {
    if (!token) {
      throw createError(401, "Error introspecting token: 'token' is empty");
    }

    const cache = this.cacheSettings();
    const key = cache.enabled ? this.cacheKey(token) : '';
    if (cache.enabled) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > this.now()) return hit.claims;
      if (hit) this.cache.delete(key); // expired — drop and re-introspect
    }

    const authMethod = this.config.clientAuthMethod ?? 'basic';
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...this.config.headers,
    };
    const body = new URLSearchParams({
      token,
      token_type_hint: this.config.tokenTypeHint ?? 'access_token',
    });

    const {clientId, clientSecret} = this.config;
    if (authMethod === 'basic' && clientId) {
      const creds = Buffer.from(`${clientId}:${clientSecret ?? ''}`).toString(
        'base64',
      );
      headers.authorization = `Basic ${creds}`;
    } else if (authMethod === 'post' && clientId) {
      body.set('client_id', clientId);
      if (clientSecret != null) body.set('client_secret', clientSecret);
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(this.config.introspectionUrl, {
        method: 'POST',
        headers,
        body,
      });
    } catch (err) {
      throw createError(
        503,
        `Introspection request failed: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      throw createError(
        503,
        `Introspection endpoint returned ${response.status}`,
      );
    }

    const claims = (await response.json()) as IntrospectionResponse | null;
    if (!claims || claims.active !== true) {
      throw createError(401, 'Token is inactive or invalid');
    }

    if (cache.enabled) this.store(key, claims, cache);
    return claims;
  }

  private cacheSettings(): {
    enabled: boolean;
    ttlMs: number;
    maxEntries: number;
  } {
    const c = this.config.cache;
    if (!c) return {enabled: false, ttlMs: 0, maxEntries: 0};
    const cfg = c === true ? {} : c;
    return {
      enabled: true,
      ttlMs: (cfg.ttlSeconds ?? 60) * 1000,
      maxEntries: cfg.maxEntries ?? 1000,
    };
  }

  private cacheKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Cache an active result, bounding its lifetime by the token's own `exp`. */
  private store(
    key: string,
    claims: IntrospectionResponse,
    cache: {ttlMs: number; maxEntries: number},
  ): void {
    const now = this.now();
    let expiresAt = now + cache.ttlMs;
    if (typeof claims.exp === 'number') {
      expiresAt = Math.min(expiresAt, claims.exp * 1000);
    }
    if (expiresAt <= now) return; // already expired — not worth caching
    this.cache.set(key, {claims, expiresAt});
    // Evict oldest (insertion order) once over capacity.
    if (this.cache.size > cache.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
