// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {schemaPropertyInfo, type RouteSchemas} from '@agentback/openapi';

/** Extract `{name}` placeholders from an OpenAPI-style path template. */
export function extractPathPlaceholders(p: string): string[] {
  return Array.from(p.matchAll(/\{([^}]+)\}/g)).map(m => m[1]);
}

/**
 * Guardrail run at `app.start()`: a route's URL `{placeholders}` must exactly
 * match the keys of its `path:` schema (and a placeholder-bearing URL must
 * declare a `path:` schema). Throws a descriptive error naming the
 * controller/method/verb on mismatch.
 *
 * Shared by BOTH host paths so the guarantee holds identically:
 * - `RestServer.controller()` (the Express mount path), and
 * - `collectRoutes()` (the runtime-neutral fetch/native path).
 *
 * Before this was shared, native/edge mode (which skips Express mounting, and
 * therefore `controller()`) silently lost the check — a documented start-time
 * invariant that only fired in Express mode.
 */
export function assertPathSchemaMatch(
  ctorName: string,
  methodName: string,
  verb: string,
  path: string,
  schemas: RouteSchemas,
): void {
  const placeholders = extractPathPlaceholders(path);
  if (schemas.path) {
    const schemaKeys = schemaPropertyInfo(schemas.path).keys;
    const missing = placeholders.filter(p => !schemaKeys.includes(p));
    const extra = schemaKeys.filter(k => !placeholders.includes(k));
    if (missing.length || extra.length) {
      const parts: string[] = [];
      if (missing.length)
        parts.push(`URL has {${missing.join(', ')}} but schema doesn't`);
      if (extra.length)
        parts.push(`schema has [${extra.join(', ')}] but URL doesn't`);
      throw new Error(
        `${ctorName}.${methodName} @${verb}('${path}'): ` +
          `path placeholders don't match the path schema — ${parts.join('; ')}.`,
      );
    }
  } else if (placeholders.length) {
    throw new Error(
      `${ctorName}.${methodName} @${verb}('${path}'): ` +
        `URL has placeholders {${placeholders.join(', ')}} but no path: schema is declared.`,
    );
  }
}
