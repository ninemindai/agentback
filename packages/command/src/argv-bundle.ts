// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {parseArgs, type ParseArgsConfig} from 'node:util';
import {AgentError, ErrorCodes} from '@agentback/openapi';

/**
 * The keystone of the CLI projection (eng review T1 / outside voice
 * findings 1-2). A tool's `input:` schema is authored ONCE for MCP/REST/AI-SDK,
 * all of which deliver already-typed JSON — so authors write `z.number()`,
 * never `z.coerce.number()`. Argv delivers strings, so handing them straight to
 * the tool's Zod schema would reject every numeric/boolean flag. This adapter
 * coerces each raw argv value off the tool's **emitted JSON Schema** (which
 * `schemaToOpenApiSchema` already computes) before the bundle reaches
 * `callTool` — no fragile Zod-internal unwrapping.
 */

/** A minimal JSON-Schema view — just what coercion reads. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  /** A field marked `.meta({positional:true})` — consumed by position, not a flag. */
  positional?: boolean;
}

/** The effective scalar/array kind, resolving nullable `type: [...]` unions. */
function jsonKind(spec: JsonSchema): string {
  const t = spec.type;
  if (Array.isArray(t)) return t.find(x => x !== 'null') ?? 'string';
  if (t) return t;
  if (spec.enum) return 'string';
  return 'string';
}

function bad(message: string): never {
  throw new AgentError(message, {code: ErrorCodes.INVALID_INPUT});
}

/** Coerce a single raw argv value (string, or true for a bare boolean). */
function coerceScalar(raw: unknown, spec: JsonSchema, flag: string): unknown {
  switch (jsonKind(spec)) {
    case 'boolean':
      return Boolean(raw);
    case 'number':
    case 'integer': {
      const n = Number(raw);
      if (typeof raw !== 'string' || raw.trim() === '' || Number.isNaN(n))
        bad(`--${flag} expects a number, got '${String(raw)}'`);
      return n;
    }
    default:
      return raw;
  }
}

/**
 * Parse `argv` (already stripped of the tool name) into the validated slot-0
 * bundle for `callTool`, using the tool's emitted JSON Schema to decide each
 * flag's arity and coerce its value. With no schema, returns the raw parsed
 * values (an open object — the tool declared no `input:`).
 */
export function argvToBundle(
  argv: string[],
  schema?: JsonSchema,
): Record<string, unknown> {
  const props = schema?.properties;
  // No input: schema → the tool takes no validated input (slot 0 is free).
  // Without a schema there is no flag arity to derive, so stray flags are not
  // meaningful; return an empty bundle rather than mis-parse (outside voice
  // finding 2 — arity requires the schema).
  if (!props) return {};

  // Positional fields (declaration order) are consumed by position, not as
  // flags — so they are NOT registered as parseArgs options.
  const positionalNames = Object.entries(props)
    .filter(([, spec]) => spec.positional)
    .map(([name]) => name);

  const options: NonNullable<ParseArgsConfig['options']> = {};
  for (const [name, spec] of Object.entries(props)) {
    if (spec.positional) continue;
    const kind = jsonKind(spec);
    if (kind === 'boolean') options[name] = {type: 'boolean'};
    else if (kind === 'array') options[name] = {type: 'string', multiple: true};
    else options[name] = {type: 'string'};
  }

  // `node:util.parseArgs` has no --no-flag negation. Strip `--no-<bool>` tokens
  // in a pre-pass and record them, so `--no-verbose` sets false instead of
  // silently coercing a truthy string (the outside-voice boolean landmine).
  const negated = new Set<string>();
  const cleaned: string[] = [];
  for (const token of argv) {
    const m = /^--no-(.+)$/.exec(token);
    if (m && props[m[1]] && jsonKind(props[m[1]]) === 'boolean')
      negated.add(m[1]);
    else cleaned.push(token);
  }

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({values, positionals} = parseArgs({
      args: cleaned,
      options,
      strict: true,
      allowPositionals: positionalNames.length > 0,
    }));
  } catch (err) {
    bad(`command: ${(err as Error).message}`);
  }

  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(values)) {
    const spec = props[name];
    if (jsonKind(spec) === 'array' && Array.isArray(raw)) {
      const items = spec.items ?? {type: 'string'};
      out[name] = raw.map(v => coerceScalar(v, items, name));
    } else {
      out[name] = coerceScalar(raw, spec, name);
    }
  }
  for (const name of negated) out[name] = false;

  // Map bare positionals onto the positional fields, in declaration order.
  if (positionals.length > positionalNames.length) {
    bad(
      `too many arguments: expected ${positionalNames.length} ` +
        `(${positionalNames.join(', ') || 'none'}), got ${positionals.length}`,
    );
  }
  positionalNames.forEach((name, i) => {
    if (i < positionals.length)
      out[name] = coerceScalar(positionals[i], props[name], name);
  });
  return out;
}
