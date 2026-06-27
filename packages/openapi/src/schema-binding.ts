// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Binding, Context} from '@agentback/context';
import type {SchemaLike} from './zod-bridge.js';

/**
 * Binding tag marking a context binding as a *named domain schema* — a node in
 * the schema/entity registry. `@agentback/schema-explorer` discovers these with
 * `filterByTag(SCHEMA_TAG)` to render entities, and joins each bound schema
 * object (by reference identity) against the REST route registry and MCP tool
 * metadata to draw "where is this used" edges.
 *
 * Explicit registration via {@link bindSchema} is *opt-in enrichment*: it gives
 * a schema a stable name (the binding key) and an origin (e.g. its Drizzle
 * table) that anonymous `z.object(...)` references cannot carry on their own.
 * Schemas never registered still appear in the explorer — discovered from the
 * routes/tools that use them — just with a synthesized name and no origin.
 */
export const SCHEMA_TAG = 'schema';

/** Convention for schema binding keys: `schemas.<name>`. */
export const SCHEMA_KEY_PREFIX = 'schemas.';

/**
 * Provenance for a registered schema — the parts of a schema's identity that
 * are not recoverable from the (anonymous) Zod object at runtime, captured at
 * registration time where the source is still in scope. `drizzle-zod`, for
 * instance, produces an opaque schema with no link back to its table; the
 * `@agentback/drizzle` helpers thread the table name through here.
 */
export interface SchemaOrigin {
  /** Source database table this schema was derived from, if any. */
  table?: string;
  /** How the schema relates to its source, e.g. `insert`/`select`/`update`. */
  kind?: string;
  /** Free-form note shown in the explorer detail view. */
  note?: string;
}

/**
 * Register a Zod (or Standard Schema) object as a named domain schema in the DI
 * container so it becomes a first-class node in the schema explorer — and, as a
 * bonus, shows up in the context explorer alongside the rest of the wiring.
 *
 * The schema object is bound *by reference* (constant binding), which is what
 * lets the explorer join it against route/tool registries by identity. Call
 * BEFORE `app.start()`.
 *
 * @example
 *   const Greeting = z.object({message: z.string()});
 *   bindSchema(app, 'Greeting', Greeting);
 *   // -> binding `schemas.Greeting`, tagged `schema`, value === Greeting
 */
export function bindSchema(
  ctx: Context,
  name: string,
  schema: SchemaLike,
  origin: SchemaOrigin = {},
): Binding<SchemaLike> {
  const tags: Record<string, unknown> = {[SCHEMA_TAG]: name};
  if (origin.table !== undefined) tags.table = origin.table;
  if (origin.kind !== undefined) tags.kind = origin.kind;
  if (origin.note !== undefined) tags.note = origin.note;
  return ctx
    .bind<SchemaLike>(`${SCHEMA_KEY_PREFIX}${name}`)
    .to(schema)
    .tag(tags);
}
