// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Proves the table → Zod → (route/tool) chain works without a database: a
// pgTable declaration alone (no connection) feeds drizzle-zod, and the
// resulting Zod schemas are ordinary schemas usable as @post body / @tool
// input.
import {integer, pgTable, serial, text} from 'drizzle-orm/pg-core';
import {describe, expect, it} from 'vitest';
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from '../../zod.js';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  age: integer('age'),
});

describe('drizzle-zod chain (no database needed)', () => {
  it('createInsertSchema validates a well-formed row', () => {
    const NewUser = createInsertSchema(users);
    const parsed = NewUser.parse({email: 'ada@example.com', name: 'Ada'});
    expect(parsed).toEqual({email: 'ada@example.com', name: 'Ada'});
  });

  it('createInsertSchema treats columns with defaults / nullable as optional', () => {
    const NewUser = createInsertSchema(users);
    // serial id (has default) and nullable age may be supplied explicitly
    const parsed = NewUser.parse({
      id: 7,
      email: 'ada@example.com',
      name: 'Ada',
      age: null,
    });
    expect(parsed.id).toBe(7);
    expect(parsed.age).toBeNull();
  });

  it('createInsertSchema rejects rows missing notNull columns', () => {
    const NewUser = createInsertSchema(users);
    const result = NewUser.safeParse({name: 'No Email'});
    expect(result.success).toBe(false);
  });

  it('createInsertSchema rejects wrongly-typed values', () => {
    const NewUser = createInsertSchema(users);
    expect(NewUser.safeParse({email: 42, name: 'Ada'}).success).toBe(false);
    expect(
      NewUser.safeParse({email: 'ada@example.com', name: 'Ada', age: 'old'})
        .success,
    ).toBe(false);
  });

  it('createSelectSchema requires the full row shape', () => {
    const User = createSelectSchema(users);
    expect(
      User.safeParse({id: 1, email: 'ada@example.com', name: 'Ada', age: null})
        .success,
    ).toBe(true);
    // select rows include the primary key — missing id must fail
    expect(
      User.safeParse({email: 'ada@example.com', name: 'Ada', age: null})
        .success,
    ).toBe(false);
  });

  it('createUpdateSchema makes every column optional', () => {
    const UserPatch = createUpdateSchema(users);
    expect(UserPatch.safeParse({}).success).toBe(true);
    expect(UserPatch.safeParse({name: 'Lady Lovelace'}).success).toBe(true);
    expect(UserPatch.safeParse({name: 99}).success).toBe(false);
  });
});
