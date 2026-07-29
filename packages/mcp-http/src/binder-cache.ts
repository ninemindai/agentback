// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {AuthInfo} from '@modelcontextprotocol/server';
import type {Context} from '@agentback/core';
import {loggers} from '@agentback/common';
import {MCPBindings} from '@agentback/mcp';
import type {SessionBinder} from './session.js';

const log = loggers('agentback:mcp-http:binder-cache');

/** Tunables for {@link cachedPerPrincipal}. */
export interface PrincipalCacheOptions {
  /**
   * How long a lookup stays fresh. This is your **entitlement-revocation
   * window**: a principal whose access is revoked keeps the old answer until
   * the entry expires, so choose it against your security posture, not your
   * latency budget. Default 30s.
   */
  ttlMs?: number;
  /** Maximum principals held. Oldest-inserted are evicted first. Default 1000. */
  max?: number;
  /**
   * Cache key for a principal. Defaults to `clientId` plus granted scopes, so a
   * re-issued token carrying different scopes does not reuse the old answer.
   * Anonymous callers share one key.
   */
  keyOf?: (principal: AuthInfo | undefined) => string;
}

const defaultKeyOf = (p: AuthInfo | undefined) =>
  p ? `${p.clientId} ${[...(p.scopes ?? [])].sort().join(' ')}` : ' anon';

/**
 * Wrap a per-principal lookup so it runs once per principal per TTL instead of
 * once per request.
 *
 * Under `protocol: 'stateless'` the binder runs on **every request**, not once
 * per session. A binder that hits a database for entitlements therefore
 * multiplies that query by request volume — the failure mode is not an error,
 * it is a quiet load multiplier, which is why this ships with the framework
 * instead of being left for each app to rediscover.
 *
 * The split is the point: only `lookup` is cached. `apply` runs fresh on every
 * request against that request's own context, so per-request isolation and
 * disposal are untouched. **Never cache a `Context`** — it is closed when its
 * request ends, and a reused one would be dead on arrival.
 *
 * ```ts
 * perSession: cachedPerPrincipal(
 *   principal => entitlements.toolsFor(principal?.clientId),   // cached
 *   (ctx, classes) => classes.forEach(C => addTool(ctx, C)),   // every request
 *   {ttlMs: 60_000},
 * )
 * ```
 *
 * A `lookup` that throws is **not** cached — the next request retries, so a
 * transient outage does not pin a failure for the whole TTL. Concurrent
 * requests for the same cold principal share one in-flight lookup rather than
 * stampeding it.
 */
export function cachedPerPrincipal<T>(
  lookup: (principal: AuthInfo | undefined) => T | Promise<T>,
  apply: (sessionCtx: Context, value: T, request: Request) => void,
  options: PrincipalCacheOptions = {},
): SessionBinder {
  const ttlMs = options.ttlMs ?? 30_000;
  const max = options.max ?? 1000;
  const keyOf = options.keyOf ?? defaultKeyOf;
  // Insertion-ordered, so the first key is always the oldest.
  const entries = new Map<string, {expires: number; value: Promise<T>}>();

  return async (sessionCtx, request) => {
    const principal = await sessionCtx.get(MCPBindings.REQUEST_AUTH, {
      optional: true,
    });
    const key = keyOf(principal);
    const now = Date.now();

    let hit = entries.get(key);
    if (hit && hit.expires <= now) {
      entries.delete(key);
      hit = undefined;
    }
    if (!hit) {
      // Store the promise, not the resolved value, so concurrent cold requests
      // for the same principal await one lookup instead of stampeding it.
      const value = Promise.resolve().then(() => lookup(principal));
      const fresh = {expires: now + ttlMs, value};
      hit = fresh;
      entries.set(key, fresh);
      // A failed lookup must not be pinned for the whole TTL.
      value.catch(() => {
        if (entries.get(key) === fresh) entries.delete(key);
      });
      if (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) {
          entries.delete(oldest);
          if (log.debug.enabled)
            log.debug('evicted principal entry %s', oldest);
        }
      }
    }
    apply(sessionCtx, await hit.value, request);
  };
}
