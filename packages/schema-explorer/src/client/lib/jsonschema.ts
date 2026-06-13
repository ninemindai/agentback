// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

// Pure projections of an emitted JSON Schema (draft 2020-12, as produced by
// `z.toJSONSchema`) into the bits the Fields view renders: a TS-ish type label,
// a distilled constraints list, and the object shape to recurse into. Kept
// framework-free so the rendering logic is easy to reason about and test.

export interface JSchema {
  type?: string | string[];
  properties?: Record<string, JSchema>;
  required?: string[];
  items?: JSchema;
  anyOf?: JSchema[];
  oneOf?: JSchema[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  default?: unknown;
  description?: string;
  additionalProperties?: boolean | JSchema;
}

const MAX = 48;
const trunc = (s: string) => (s.length > MAX ? s.slice(0, MAX - 1) + '…' : s);

/** Peel a `T | null` union down to its single non-null member, recursively. */
export function unwrapNullable(s: JSchema): JSchema {
  const variants = s.anyOf ?? s.oneOf;
  if (variants) {
    const nonNull = variants.filter(v => v.type !== 'null');
    if (nonNull.length === 1) return unwrapNullable(nonNull[0]!);
  }
  return s;
}

/** A TS-ish, single-line type label: `string[]`, `"a" | "b"`, `integer | null`. */
export function typeLabel(s: JSchema | undefined): string {
  if (!s || typeof s !== 'object') return 'any';
  if (s.const !== undefined) return trunc(JSON.stringify(s.const));
  if (Array.isArray(s.enum)) {
    const parts = s.enum.map(v => JSON.stringify(v));
    return trunc(
      parts.length <= 4
        ? parts.join(' | ')
        : `${parts.slice(0, 3).join(' | ')} | +${parts.length - 3}`,
    );
  }
  const variants = s.anyOf ?? s.oneOf;
  if (Array.isArray(variants)) {
    return trunc([...new Set(variants.map(typeLabel))].join(' | '));
  }
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.type === 'array') return `${typeLabel(s.items)}[]`;
  if (s.type === 'object' || s.properties) {
    if (s.properties) return 'object';
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      return `record<${typeLabel(s.additionalProperties)}>`;
    }
    return 'object';
  }
  return (s.type as string) ?? 'any';
}

function span(
  min: number | undefined,
  max: number | undefined,
  unit: string,
): string | null {
  if (min != null && max != null) {
    return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
  }
  if (min != null) return `≥ ${min} ${unit}`;
  if (max != null) return `≤ ${max} ${unit}`;
  return null;
}

// Integer-range sentinels (int8/16/32, JS safe-int) that DB/zod emit as
// minimum/maximum on plain integer columns. They're noise, not real domain
// bounds, so they're hidden on integer types — a user's own `min(0)` survives.
const INT_SENTINELS = new Set([
  127, -128, 32767, -32768, 2147483647, -2147483648, 9007199254740991,
  -9007199254740991,
]);

function isInteger(s: JSchema): boolean {
  return (
    s.type === 'integer' ||
    (Array.isArray(s.type) && s.type.includes('integer'))
  );
}

/** Human-readable constraint chips distilled from JSON-Schema keywords. */
export function constraints(s: JSchema): string[] {
  const out: (string | null)[] = [];
  if (s.format) out.push(`format: ${s.format}`);
  out.push(span(s.minLength, s.maxLength, 'chars'));
  out.push(span(s.minItems, s.maxItems, 'items'));
  const sentinel = isInteger(s);
  if (s.minimum != null && !(sentinel && INT_SENTINELS.has(s.minimum))) {
    out.push(`≥ ${s.minimum}`);
  }
  if (s.maximum != null && !(sentinel && INT_SENTINELS.has(s.maximum))) {
    out.push(`≤ ${s.maximum}`);
  }
  if (s.exclusiveMinimum != null) out.push(`> ${s.exclusiveMinimum}`);
  if (s.exclusiveMaximum != null) out.push(`< ${s.exclusiveMaximum}`);
  if (s.multipleOf != null) out.push(`×${s.multipleOf}`);
  if (s.pattern) out.push(`/${trunc(s.pattern)}/`);
  if (s.default !== undefined)
    out.push(`default ${trunc(JSON.stringify(s.default))}`);
  return out.filter((x): x is string => x != null);
}

/**
 * The properties-bearing object reached from a schema by unwrapping nullable
 * unions and array `items`, or `null` if there is no object shape to expand
 * (a primitive, or an array of primitives).
 */
export function objectShape(s: JSchema): JSchema | null {
  const u = unwrapNullable(s);
  if (u.properties) return u;
  if (u.type === 'array' && u.items) return objectShape(u.items);
  return null;
}

/** True when the schema (ignoring nullability) is an array at the top level. */
export function isArrayRoot(s: JSchema): boolean {
  return unwrapNullable(s).type === 'array';
}
