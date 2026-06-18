// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Single source of truth: ONE table declaration feeds drizzle-zod, and the
// resulting Zod schemas drive the row type, the runtime validator, the
// OpenAPI document, AND the MCP tool schema. No second source, no codegen.
//
// `createInsertSchema` / `createSelectSchema` come from the `/zod` subpath of
// @agentback/drizzle (drizzle-zod re-exports — kept off the main index
// because drizzle-zod is an optional peer dep).

import {pgTable, serial, text, timestamp} from 'drizzle-orm/pg-core';
import {
  createInsertSchema,
  createSelectSchema,
} from '@agentback/drizzle/zod';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Insert shape: id + createdAt have defaults, so they're optional on insert. */
export const NewUser = createInsertSchema(users);

/** Select shape: the full persisted row (id + createdAt always present). */
export const User = createSelectSchema(users);
