// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The controller injects a small data-access PORT, not a live DB driver. This
// is what keeps the example runnable in CI with zero database: drizzle-orm
// against Postgres needs a server, but the artifact CHAIN being demonstrated
// (table -> Zod -> REST body + OpenAPI + MCP tool) is real and lives entirely
// in db/schema.ts. The README shows how to swap this in-memory store for a
// Postgres-backed one via `registerDrizzle` + `DrizzleBindings.CLIENT`.

import {BindingKey} from '@agentback/core';
import {z} from 'zod';
import {NewUser, User} from './db/schema.js';

export type NewUser = z.infer<typeof NewUser>;
export type User = z.infer<typeof User>;

/** Data-access port the controller depends on (swappable via DI). */
export interface UserStore {
  create(input: NewUser): Promise<User>;
}

export const USER_STORE = BindingKey.create<UserStore>('stores.UserStore');

/**
 * Default in-memory implementation. A real app binds a Postgres-backed store
 * that runs `db.insert(users).values(input).returning()` against the Drizzle
 * client resolved from `DrizzleBindings.CLIENT` — see the README.
 */
export class InMemoryUserStore implements UserStore {
  private nextId = 1;
  private readonly rows: User[] = [];

  async create(input: NewUser): Promise<User> {
    const row: User = {
      id: input.id ?? this.nextId++,
      email: input.email,
      name: input.name,
      createdAt: input.createdAt ?? new Date(),
    };
    this.rows.push(row);
    return row;
  }
}
