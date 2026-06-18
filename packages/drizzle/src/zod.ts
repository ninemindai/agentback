// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Re-exports of the `drizzle-zod` schema factories so app code has a single
 * import root and the version is centrally pinned against the workspace Zod
 * major.
 *
 * This lives on its own subpath — `@agentback/drizzle/zod` — rather than
 * the main index, because `drizzle-zod` is an *optional* peer dependency: a
 * static re-export from the main index would make the whole package fail to
 * load (`ERR_MODULE_NOT_FOUND`) for apps that only want `registerDrizzle` and
 * derive their Zod schemas some other way. Importing this subpath requires
 * `drizzle-zod` to be installed.
 *
 * ```ts
 * import {createInsertSchema, createSelectSchema} from '@agentback/drizzle/zod';
 * ```
 */
import {getTableName, type Table} from 'drizzle-orm';
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-zod';
import {bindSchema} from '@agentback/openapi';
import type {Context} from '@agentback/context';

export {createInsertSchema, createSelectSchema, createUpdateSchema};

/**
 * Build the insert-shape Zod schema for a Drizzle table AND register it in the
 * DI container as a named domain schema, tagged with its source table. This is
 * the *origin-capturing* form: `drizzle-zod` produces an opaque schema with no
 * link back to its table, so the table name is recorded here — the one place
 * it is still in scope — for `@agentback/schema-explorer` to surface in the
 * provenance graph.
 *
 * Returns the schema so you can reuse the same object as a route body / tool
 * input (the shared reference is what lets the explorer join REST + MCP usage).
 *
 * @param ctx  The application (or any context) to bind into. Call before start.
 * @param table  The Drizzle table to derive the insert schema from.
 * @param name  Binding name override; defaults to `<table>.insert`.
 *
 * @example
 *   const NewUser = registerInsertSchema(app, users, 'NewUser');
 *   // @post('/', {body: NewUser}) + @tool('create_user', {input: NewUser})
 */
export function registerInsertSchema<T extends Table>(
  ctx: Context,
  table: T,
  name?: string,
) {
  const schema = createInsertSchema(table);
  const tableName = getTableName(table);
  bindSchema(ctx, name ?? `${tableName}.insert`, schema, {
    table: tableName,
    kind: 'insert',
  });
  return schema;
}

/**
 * Build the select-shape (persisted row) Zod schema for a Drizzle table and
 * register it as a named domain schema tagged with its source table. See
 * {@link registerInsertSchema}. Defaults the binding name to `<table>.select`.
 */
export function registerSelectSchema<T extends Table>(
  ctx: Context,
  table: T,
  name?: string,
) {
  const schema = createSelectSchema(table);
  const tableName = getTableName(table);
  bindSchema(ctx, name ?? `${tableName}.select`, schema, {
    table: tableName,
    kind: 'select',
  });
  return schema;
}

/**
 * Build the update-shape Zod schema for a Drizzle table and register it as a
 * named domain schema tagged with its source table. See
 * {@link registerInsertSchema}. Defaults the binding name to `<table>.update`.
 */
export function registerUpdateSchema<T extends Table>(
  ctx: Context,
  table: T,
  name?: string,
) {
  const schema = createUpdateSchema(table);
  const tableName = getTableName(table);
  bindSchema(ctx, name ?? `${tableName}.update`, schema, {
    table: tableName,
    kind: 'update',
  });
  return schema;
}
