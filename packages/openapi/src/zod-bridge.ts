// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z, ZodObject, ZodRawShape, ZodType} from 'zod';
import {isStandardSchema, type StandardSchemaV1} from './standard-schema.js';
import type {ReferenceObject, SchemaObject} from './types.js';

const ZOD_SCHEMA = Symbol.for('agentback.zod-schema');

/**
 * Attach a Zod schema to an object as a non-enumerable property. The
 * attachment is lost when the object passes through metadata cloning, so
 * route schemas are also recorded in the side registry below — that's the
 * authoritative store consulted by the validator.
 */
export function attachZodSchema<T extends object>(
  target: T,
  schema: ZodType,
): T {
  Object.defineProperty(target, ZOD_SCHEMA, {
    value: schema,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return target;
}

export function getZodSchema(target: unknown): ZodType | undefined {
  if (target == null || typeof target !== 'object') return undefined;
  return (target as Record<symbol, ZodType>)[ZOD_SCHEMA];
}

export function isZodSchema(value: unknown): value is ZodType {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as {parse?: unknown}).parse === 'function' &&
    typeof (value as {safeParse?: unknown}).safeParse === 'function'
  );
}

/**
 * Convert a Zod schema to an OpenAPI 3.1 SchemaObject using Zod v4's
 * native JSON Schema 2020-12 emission. OpenAPI 3.1's default dialect
 * is JSON Schema 2020-12, so this is a direct mapping.
 */
export function zodToOpenApiSchema(
  schema: ZodType,
): SchemaObject | ReferenceObject {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    unrepresentable: 'any',
    io: 'output',
  });
  return json as SchemaObject;
}

// ----- Standard Schema support -----

/**
 * Any schema a decorator slot accepts: a Zod schema (first-class — native
 * JSON Schema emission) or any Standard Schema V1 (`~standard`) — Valibot,
 * ArkType, etc. Non-Zod schemas validate fine; OpenAPI emission needs a
 * JSON Schema source (native capability or a registered converter), enforced
 * at startup — boundary coherence forbids undescribed boundaries.
 */
export type SchemaLike = ZodType | StandardSchemaV1;

/** Output type of a SchemaLike — `z.infer` or Standard Schema inference. */
export type InferSchema<S> = S extends ZodType
  ? z.infer<S>
  : S extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<S>
    : never;

/** Normalized validation issue (superset shape shared with rest's errors). */
export interface ParseIssue {
  path: (string | number)[];
  message: string;
  code?: string;
  expected?: string;
  received?: string;
}

export type ParseResult =
  | {success: true; data: unknown}
  | {success: false; issues: ParseIssue[]};

/**
 * Validate a value against any SchemaLike, synchronously. Zod fast-path via
 * `safeParse`; otherwise the `~standard` validate (async results are
 * rejected — request validation is synchronous by design).
 */
export function standardParse(schema: SchemaLike, value: unknown): ParseResult {
  if (isZodSchema(schema)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return {success: true, data: parsed.data};
    return {
      success: false,
      issues: parsed.error.issues.map(i => ({
        path: i.path as (string | number)[],
        code: i.code,
        message: i.message,
        expected: (i as {expected?: string}).expected,
        received: (i as {received?: string}).received,
      })),
    };
  }
  const result = schema['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new Error(
      `Async validation is not supported on request schemas ` +
        `(vendor '${schema['~standard'].vendor}'). Use a synchronous schema.`,
    );
  }
  if (result.issues == null) return {success: true, data: result.value};
  return {
    success: false,
    issues: result.issues.map(i => ({
      path: (i.path ?? []).map(seg =>
        typeof seg === 'object' && seg != null && 'key' in seg
          ? (seg.key as string | number)
          : (seg as string | number),
      ),
      message: i.message,
    })),
  };
}

/** vendor → JSON Schema converter, for libraries without native emission. */
type JSONSchemaConverter = (
  schema: StandardSchemaV1,
) => SchemaObject | ReferenceObject;
const jsonSchemaConverters = new Map<string, JSONSchemaConverter>();

/**
 * Register a JSON Schema converter for a Standard Schema vendor, e.g.
 * `registerJSONSchemaConverter('valibot', s => toJsonSchema(s))`.
 */
export function registerJSONSchemaConverter(
  vendor: string,
  converter: JSONSchemaConverter,
): void {
  jsonSchemaConverters.set(vendor, converter);
}

/**
 * Emit JSON Schema for any SchemaLike. Resolution order: Zod native →
 * schema's own `toJsonSchema()` capability (ArkType) → registered vendor
 * converter → throw. The throw is deliberate and surfaces at `app.start()`:
 * a schema that can validate but not describe itself must not silently emit
 * `{}` into /openapi.json.
 */
export function schemaToOpenApiSchema(
  schema: SchemaLike,
): SchemaObject | ReferenceObject {
  if (isZodSchema(schema)) return zodToOpenApiSchema(schema);
  const withCapability = schema as StandardSchemaV1 & {
    toJsonSchema?: (opts?: object) => SchemaObject;
  };
  if (typeof withCapability.toJsonSchema === 'function') {
    return withCapability.toJsonSchema();
  }
  const vendor = schema['~standard'].vendor;
  const converter = jsonSchemaConverters.get(vendor);
  if (converter) return converter(schema);
  throw new Error(
    `Cannot emit JSON Schema for a '${vendor}' schema: it has no native ` +
      `toJsonSchema() and no converter is registered. Call ` +
      `registerJSONSchemaConverter('${vendor}', ...) before app.start().`,
  );
}

/** `true` when `undefined` passes the schema (drives `required` emission). */
export function isOptionalSchema(schema: SchemaLike): boolean {
  try {
    return standardParse(schema, undefined).success;
  } catch {
    return false;
  }
}

/**
 * Property names + required-ness of an object-shaped schema. Zod objects
 * answer from `shape`; other vendors from their emitted JSON Schema. Used by
 * the path-placeholder check and parameter emission.
 */
export function schemaPropertyInfo(schema: SchemaLike): {
  keys: string[];
  required: Set<string>;
  /** Per-property JSON Schema, when derivable. */
  properties: Record<string, SchemaObject | ReferenceObject>;
} {
  if (isZodSchema(schema)) {
    const shape = (schema as ZodObject<ZodRawShape>).shape ?? {};
    const keys = Object.keys(shape);
    const required = new Set(
      keys.filter(k => !isOptionalSchema(shape[k] as ZodType)),
    );
    const properties: Record<string, SchemaObject | ReferenceObject> = {};
    for (const k of keys)
      properties[k] = zodToOpenApiSchema(shape[k] as ZodType);
    return {keys, required, properties};
  }
  const json = schemaToOpenApiSchema(schema) as SchemaObject & {
    properties?: Record<string, SchemaObject | ReferenceObject>;
    required?: string[];
  };
  const properties = json.properties ?? {};
  return {
    keys: Object.keys(properties),
    required: new Set(json.required ?? []),
    properties,
  };
}

// ----- side registry that survives metadata cloning -----

/** The schemas attached to a single route method (Zod or Standard Schema). */
export interface RouteSchemas {
  body?: SchemaLike;
  path?: SchemaLike;
  query?: SchemaLike;
  headers?: SchemaLike;
  response?: SchemaLike;
  /** Per-item schema for SSE stream routes (mutually exclusive with response). */
  streamOf?: SchemaLike;
  /** Wire format for a `streamOf` route: `'sse'` (default) or `'jsonl'`. */
  format?: 'sse' | 'jsonl';
  /** Additional status-code → schema map for documentation. */
  responses?: Record<number, SchemaLike>;
  /** Dangerous operation: require a confirmation-token round-trip. */
  confirm?: boolean | {ttlMs?: number};
  /** Mutation dedupe: honor the `idempotency-key` request header. */
  idempotency?: boolean | {required?: boolean; ttlMs?: number};
}

type Key = `${string}::${string}`;
const routeRegistry = new Map<Key, RouteSchemas>();

function key(ctorOrProto: object, methodName: string | symbol): Key {
  const className =
    (ctorOrProto as {constructor?: {name: string}}).constructor?.name ??
    (ctorOrProto as {name?: string}).name ??
    'anonymous';
  return `${className}::${String(methodName)}`;
}

/** Record the schemas declared on a route method's verb decorator. */
export function registerRouteSchemas(
  proto: object,
  methodName: string | symbol,
  schemas: RouteSchemas,
): void {
  routeRegistry.set(key(proto, methodName), schemas);
}

/** Look up the schemas registered for a route method. */
export function lookupRouteSchemas(
  proto: object,
  methodName: string | symbol,
): RouteSchemas | undefined {
  return routeRegistry.get(key(proto, methodName));
}
