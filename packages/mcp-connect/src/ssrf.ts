// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {lookup} from 'node:dns/promises';
import {ipVersion, isBlockedAddress} from '@agentback/common';
import type {FetchLike} from '@agentback/mcp-client';

/**
 * Thrown when a target URL is refused by the SSRF guard. Carries `statusCode`
 * 400 so mountMcpConnect surfaces it as a client error, not a 500.
 */
export class BlockedUrlError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

/**
 * Validate a target URL for SSRF safety: only http(s), and the host must not
 * be (or resolve to) a loopback / link-local / private / reserved address —
 * anything outside globally reachable space per the IANA special-purpose
 * registries (the classifier is `isBlockedAddress` from `@agentback/common`,
 * shared with `@agentback/mcp-events`). DNS names are resolved and **every**
 * returned address is checked — a name that resolves to an internal IP (or the
 * cloud metadata endpoint) is rejected.
 *
 * Note: this is a check-at-validation-time guard. It does not pin the resolved
 * IP, so a name that re-resolves to an internal address *after* this check
 * (DNS rebinding) or an HTTP redirect to an internal URL is not fully covered;
 * deployments exposing this API should also gate it behind authentication and
 * restrict the server's outbound network egress. `@agentback/mcp-events`
 * builds the connect-time variant (`createPinnedTransport`) for webhook
 * delivery, where the target URL is attacker-supplied by design.
 */
export async function assertPublicUrl(raw: string | URL): Promise<URL> {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    throw new BlockedUrlError(`Invalid URL: ${String(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(
      `Only http(s) URLs are allowed (got "${url.protocol}")`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (ipVersion(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedUrlError(
        `Refusing to connect to private/reserved address ${host}`,
      );
    }
    return url;
  }
  let addrs: {address: string}[];
  try {
    addrs = await lookup(host, {all: true});
  } catch {
    throw new BlockedUrlError(`Cannot resolve host "${host}"`);
  }
  for (const {address} of addrs) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(
        `Host "${host}" resolves to a private/reserved address (${address})`,
      );
    }
  }
  return url;
}

/**
 * Wrap a fetch so every request URL is run through {@link assertPublicUrl}
 * first. Passed as the OAuth flow's `fetchFn` (guarding discovery / token /
 * registration endpoints) and as the transport fetch.
 */
export function guardedFetch(base: FetchLike = fetch): FetchLike {
  return (async (input: string | URL, init?: RequestInit) => {
    const target =
      typeof input === 'string' || input instanceof URL
        ? input
        : (input as Request).url;
    await assertPublicUrl(target);
    return base(input, init);
  }) as FetchLike;
}
