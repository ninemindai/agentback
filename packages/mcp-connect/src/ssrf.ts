// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
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

function isBlockedV4(ip: string): boolean {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = o as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10/8 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 168) || // 192.168/16 private
    a >= 224 // multicast / reserved
  );
}

function isBlockedV6(ip: string): boolean {
  const a = ip.toLowerCase();
  if (a === '::1' || a === '::') return true; // loopback / unspecified
  if (
    a.startsWith('fe8') ||
    a.startsWith('fe9') ||
    a.startsWith('fea') ||
    a.startsWith('feb')
  ) {
    return true; // fe80::/10 link-local
  }
  if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 ULA
  const mapped = a.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // IPv4-mapped
  return mapped ? isBlockedV4(mapped[1]!) : false;
}

function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  return v === 4 ? isBlockedV4(ip) : v === 6 ? isBlockedV6(ip) : false;
}

/**
 * Validate a target URL for SSRF safety: only http(s), and the host must not
 * be (or resolve to) a loopback / link-local / private / reserved address. DNS
 * names are resolved and **every** returned address is checked — a name that
 * resolves to an internal IP (or the cloud metadata endpoint) is rejected.
 *
 * Note: this is a check-at-validation-time guard. It does not pin the resolved
 * IP, so a name that re-resolves to an internal address *after* this check
 * (DNS rebinding) or an HTTP redirect to an internal URL is not fully covered;
 * deployments exposing this API should also gate it behind authentication and
 * restrict the server's outbound network egress.
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
  if (isIP(host)) {
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
