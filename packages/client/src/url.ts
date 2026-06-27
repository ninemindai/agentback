// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Substitute `{name}` placeholders in an OpenAPI-style path template with
 * values from `params`. Each value is URI-encoded.
 */
export function expandPath(
  template: string,
  params: Record<string, unknown> | undefined,
): string {
  return template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const v = params?.[key];
    if (v === undefined || v === null) {
      throw new Error(
        `Missing path parameter '${key}' for template '${template}'.`,
      );
    }
    return encodeURIComponent(String(v));
  });
}

/**
 * Serialize a parsed query object to a `?a=1&b=2` string. Undefined/null
 * keys are omitted. Arrays are repeated with the same name (matching the
 * default `qs`-style express parser).
 */
export function encodeQuery(
  query: Record<string, unknown> | undefined,
): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item === undefined || item === null) continue;
        params.append(k, String(item));
      }
    } else {
      params.append(k, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Combine a baseURL with a path. Tolerates either side having a trailing
 * or leading slash. Result has exactly one slash between them.
 */
export function joinUrl(base: string, path: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const p = path.startsWith('/') ? path : `/${path}`;
  return b + p;
}
