// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The address classifier every outbound-URL guard shares (`mcp-connect`'s
 * SSRF check, `mcp-events`' IP-pinned webhook transport). Pure string and
 * integer work with no `node:net`, so it loads on every host.
 *
 * The rule is "globally reachable" in the sense of the IANA IPv4 and IPv6
 * Special-Purpose Address Registries: loopback, private, link-local, CGNAT,
 * documentation, benchmarking, multicast and reserved space are all refused,
 * and an IPv4 address embedded in IPv6 (mapped, NAT64, 6to4) is judged by the
 * IPv4 it carries. Where a registry block has a few globally reachable
 * exceptions (e.g. inside `192.0.0.0/24` or `2001::/23`), the whole block is
 * refused: a webhook or proxy target has no business being an anycast
 * protocol relay, and a false refusal is a configuration error while a false
 * acceptance is an SSRF.
 */

/**
 * The IP version of `value` (4 or 6), or 0 when it is not an IP literal.
 * Accepts bracketed IPv6 (`[::1]`) and an IPv6 zone id (`fe80::1%eth0`).
 */
export function ipVersion(value: string): 0 | 4 | 6 {
  if (parseIPv4(value)) return 4;
  if (parseIPv6(stripIPv6(value))) return 6;
  return 0;
}

/**
 * True when `ip` is an IP literal in globally reachable unicast space.
 * False for anything else, including a string that is not an IP at all.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicV4(v4);
  const v6 = parseIPv6(stripIPv6(ip));
  if (v6) return isPublicV6(v6);
  return false;
}

/**
 * The negation of {@link isPublicAddress}: true for loopback, private,
 * link-local, reserved and special-purpose addresses, **and for a string that
 * is not an IP literal** — a guard that cannot classify its input refuses it.
 */
export function isBlockedAddress(ip: string): boolean {
  return !isPublicAddress(ip);
}

function stripIPv6(value: string): string {
  let v = value;
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  const zone = v.indexOf('%');
  return zone === -1 ? v : v.slice(0, zone);
}

/** Four octets, or undefined. Strict dotted-quad: no octal, no short forms. */
function parseIPv4(value: string): number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return undefined;
    const n = Number(p);
    if (n > 255) return undefined;
    out.push(n);
  }
  return out;
}

/** Eight 16-bit groups, or undefined. Handles `::` and an IPv4 tail. */
function parseIPv6(value: string): number[] | undefined {
  if (!value.includes(':')) return undefined;
  let head = value;
  const tail: number[] = [];
  const lastColon = value.lastIndexOf(':');
  const maybeV4 = value.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return undefined;
    tail.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    head = value.slice(0, lastColon + 1);
    // `::1.2.3.4` leaves `::`; `64:ff9b::1.2.3.4` leaves `64:ff9b::`; a bare
    // `a:b:c:d:e:f:1.2.3.4` leaves `a:b:c:d:e:f:` with a dangling colon.
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }
  const doubled = head.split('::');
  if (doubled.length > 2) return undefined;
  const groups = (s: string): number[] | undefined => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = groups(doubled[0]!);
  if (!left) return undefined;
  if (doubled.length === 1) {
    const all = [...left, ...tail];
    return all.length === 8 ? all : undefined;
  }
  const right = groups(doubled[1]!);
  if (!right) return undefined;
  const fill = 8 - left.length - right.length - tail.length;
  if (fill < 1) return undefined;
  return [...left, ...new Array<number>(fill).fill(0), ...right, ...tail];
}

function isPublicV4([a, b, c]: number[]): boolean {
  return !(
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    (a === 100 && b! >= 64 && b! <= 127) || // 100.64.0.0/10 CGNAT
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local (cloud metadata)
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF assignments
    (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 192.88.99.0/24 6to4 relay
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && b === 51 && c === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // 203.0.113.0/24 TEST-NET-3
    a! >= 224 // 224/4 multicast, 240/4 reserved, broadcast
  );
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isPublicV6(g: number[]): boolean {
  // ::ffff:0:0/96 IPv4-mapped — judged by the IPv4 address it carries.
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return isPublicV4(embeddedV4(g[6]!, g[7]!));
  }
  // 64:ff9b::/96 well-known NAT64 prefix — likewise.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isPublicV4(embeddedV4(g[6]!, g[7]!));
  }
  // Only 2000::/3 is global unicast. Everything else — ::/128, ::1, the
  // deprecated IPv4-compatible ::/96, 64:ff9b:1::/48, 100::/64 discard,
  // 5f00::/16 SRv6, fc00::/7 ULA, fe80::/10 link-local, fec0::/10, ff00::/8
  // multicast — falls outside it.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // 2002::/16 6to4 — judged by the IPv4 address in bits 16–47.
  if (g[0] === 0x2002) return isPublicV4(embeddedV4(g[1]!, g[2]!));
  // 2001::/23 IETF protocol assignments (Teredo, ORCHID, benchmarking, …).
  if (g[0] === 0x2001 && g[1]! < 0x0200) return false;
  // 2001:db8::/32 and 3fff::/20 documentation.
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false;
  return true;
}
