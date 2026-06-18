// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/drizzle
// This file is licensed under the MIT License.

// Proves the register*Schema helpers both BUILD a drizzle-zod schema and
// REGISTER it in the container with its source-table origin — the leg the
// schema-explorer cannot recover on its own, since drizzle-zod produces an
// opaque schema with no link back to its table.

import {describe, expect, it} from 'vitest';
import {integer, pgTable, serial, text} from 'drizzle-orm/pg-core';
import {Context} from '@agentback/context';
import {SCHEMA_TAG} from '@agentback/openapi';
import {
  registerInsertSchema,
  registerSelectSchema,
  registerUpdateSchema,
} from '../../zod.js';

const widgets = pgTable('widgets', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  qty: integer('qty'),
});

describe('register*Schema helpers', () => {
  it('binds a select schema tagged with table + kind and returns it', () => {
    const ctx = new Context('test');
    const schema = registerSelectSchema(ctx, widgets);

    // Returned object is a usable Zod schema.
    expect(schema.parse({id: 1, name: 'a', qty: null})).toEqual({
      id: 1,
      name: 'a',
      qty: null,
    });

    // Registered under `schemas.<default>` with the schema tag + origin.
    const [binding] = ctx.findByTag(SCHEMA_TAG);
    expect(binding).toBeDefined();
    expect(binding!.key).toBe('schemas.widgets.select');
    expect(binding!.tagMap.table).toBe('widgets');
    expect(binding!.tagMap.kind).toBe('select');
    // The bound value is the SAME object returned (identity preserved).
    expect(ctx.getSync(binding!.key)).toBe(schema);
  });

  it('honors a name override and supports insert/update kinds', () => {
    const ctx = new Context('test');
    registerInsertSchema(ctx, widgets, 'NewWidget');
    registerUpdateSchema(ctx, widgets);

    const keys = ctx.findByTag(SCHEMA_TAG).map(b => b.key);
    expect(keys).toContain('schemas.NewWidget');
    expect(keys).toContain('schemas.widgets.update');

    const insert = ctx.find('schemas.NewWidget')[0]!;
    expect(insert.tagMap.kind).toBe('insert');
    expect(insert.tagMap.table).toBe('widgets');
  });
});
