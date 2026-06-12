// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Resolve `${VAR}` and `${VAR:-default}` references in a string against
 * `process.env`. A missing var with no default throws — config errors should
 * surface at load time, not be silently empty.
 */
export function resolveEnvVars(str: string): string {
  return str.replace(
    /\$\{([^}:]+)(?::-([^}]*))?\}/g,
    (_match, varName: string, defaultValue: string | undefined) => {
      const value = process.env[varName.trim()];
      if (value !== undefined) return value;
      if (defaultValue !== undefined) return defaultValue;
      throw new Error(`Environment variable ${varName} is not set`);
    },
  );
}

/** Recursively rewrite every string in `obj` via `resolveEnvVars`. */
export function resolveEnvVarsInObject<T>(obj: T): T {
  if (typeof obj === 'string') return resolveEnvVars(obj) as unknown as T;
  if (Array.isArray(obj))
    return obj.map(resolveEnvVarsInObject) as unknown as T;
  if (obj !== null && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = resolveEnvVarsInObject(v);
    }
    return out as T;
  }
  return obj;
}
