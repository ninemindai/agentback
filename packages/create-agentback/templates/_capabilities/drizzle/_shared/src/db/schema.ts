// Single source of truth: ONE table feeds drizzle-zod, and the resulting Zod
// schemas drive the row type, the runtime validator, the OpenAPI document, and
// the MCP tool schema. No second source, no codegen.

import {pgTable, serial, text, timestamp} from 'drizzle-orm/pg-core';
import {createInsertSchema, createSelectSchema} from '@agentback/drizzle/zod';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Insert shape: id + createdAt have defaults, so they're optional on insert. */
export const NewUser = createInsertSchema(users);

/** Select shape: the full persisted row. */
export const User = createSelectSchema(users);
