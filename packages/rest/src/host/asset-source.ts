// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/** A function that resolves a URL suffix to a Response, or undefined if not found. */
export type AssetSource = (
  suffix: string,
) => Promise<globalThis.Response | undefined>;

/**
 * Allowed content-type prefixes for CDN-proxied assets. `text/html` is
 * intentionally excluded — serving HTML from our origin would allow a
 * CDN-hosted file to execute scripts in our origin's security context (XSS).
 */
const ALLOWED_CDN_TYPES = [
  'application/javascript',
  'text/javascript',
  'text/css',
  'application/json',
  'application/wasm',
  'font/',
  'image/',
  'text/plain',
  'application/octet-stream',
];

/**
 * Serve assets from a CDN base URL instead of disk — for edge runtimes (no fs).
 * jsdelivr/unpkg serve any published npm package's files by version, e.g.
 * `https://cdn.jsdelivr.net/npm/@agentback/console@0.4.0/dist/client`.
 *
 * Security hardening: rejects protocol-relative and traversal suffixes,
 * confirms the resolved URL stays under the base origin + path, and
 * allowlists content-types to prevent serving HTML on our origin.
 */
export function fromCdn(
  baseUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): AssetSource {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return async (suffix: string): Promise<globalThis.Response | undefined> => {
    // 1. Must be rooted.
    if (!suffix.startsWith('/')) return undefined;
    // 2. Reject protocol-relative (e.g. //evil.com/x).
    if (suffix.startsWith('//')) return undefined;

    // 3. Decode and inspect segments for traversal.
    let decoded: string;
    try {
      decoded = decodeURIComponent(suffix);
    } catch {
      return undefined;
    }
    if (decoded.includes('\\')) return undefined;
    const segments = decoded.split('/');
    for (const seg of segments) {
      if (seg === '..' || seg === '.') return undefined;
    }

    // 4. Construct URLs and confirm origin + path containment.
    let baseUrlObj: URL;
    let target: URL;
    try {
      baseUrlObj = new URL(base + '/');
      target = new URL(base + suffix);
    } catch {
      return undefined;
    }
    if (
      target.origin !== baseUrlObj.origin ||
      !target.pathname.startsWith(baseUrlObj.pathname)
    ) {
      return undefined;
    }

    // 5. Fetch the resolved URL (not the raw concatenated string).
    const res = await fetchFn(target.toString());
    if (res.status !== 200) return undefined;

    // 6. Content-type allowlist — do not serve text/html on our origin.
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const mediaType = ct.split(';')[0].trim();
    const allowed = ALLOWED_CDN_TYPES.some(
      prefix => mediaType === prefix || mediaType.startsWith(prefix),
    );
    if (!allowed) return undefined;

    return new globalThis.Response(res.body, {
      headers: {
        'content-type':
          res.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  };
}
