// The controller injects a small data-access PORT, not a live DB driver — this
// keeps the scaffold runnable in CI with zero database. Swap InMemoryUserStore
// for a Postgres-backed store via `registerDrizzle` + `DrizzleBindings.CLIENT`
// when you wire up a real database (set DATABASE_URL).

import {BindingKey} from '@agentback/core';
import {z} from 'zod';
import {NewUser, User} from '../db/schema.js';

export type NewUser = z.infer<typeof NewUser>;
export type User = z.infer<typeof User>;

export interface UserStore {
  create(input: NewUser): Promise<User>;
}

export const USER_STORE = BindingKey.create<UserStore>('stores.UserStore');

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
