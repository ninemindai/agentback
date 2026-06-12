# hello-drizzle

**One artifact chain: a Postgres table → Zod schemas → a REST route + an MCP
tool.** A single `pgTable('users', …)` declaration is the source of truth.
`drizzle-zod` derives `NewUser` (insert) and `User` (select) from it, and those
same two schemas drive the REST `POST /users` body/response, the OpenAPI 3.1.1
document, AND the MCP `create_user` tool. No second schema, no codegen, no
drift.

```
db/schema.ts          POST /users (REST)      tool create_user (MCP)
  users (pgTable)  ─┬─► body: NewUser    ─┐    input:  NewUser  ◄─┐
  NewUser ─────────┘   response: User    ├──► /openapi.json       │
  User ────────────────────────────────┘    output: User  ◄──────┘
```

## Why there's no database in this example

`drizzle-orm` against Postgres needs a running server, which CI doesn't have.
So the controller injects a small **data-access port** — `UserStore` — instead
of a live driver, and the example binds an in-memory implementation by default.
The chain being demonstrated (table → Zod → REST + OpenAPI + MCP) is entirely
real and lives in [`src/db/schema.ts`](src/db/schema.ts); only the persistence
behind the port is swapped out so the app boots anywhere.

## Run

```bash
pnpm -F hello-drizzle build
pnpm -F hello-drizzle start
```

Then:

```bash
curl -s localhost:3000/users \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada"}' | jq
curl -s localhost:3000/openapi.json | jq '.paths."/users"'
# Swagger UI: http://localhost:3000/explorer/
```

## Test

```bash
pnpm -F hello-drizzle test
```

Tests run against `src` with vitest (esbuild transpiles TypeScript on the fly),
the way a standalone downstream app tests itself — see
[`vitest.config.ts`](vitest.config.ts). They cover the REST route, the MCP
tool, and a 422 on an invalid body. (Workspace package tests, by contrast, run
against built `dist/`.)

## Swapping in real Postgres

Replace the in-memory `UserStore` binding with a Postgres-backed one. Build the
Drizzle client in your app and register it with
[`@agentback/drizzle`](../../packages/drizzle/README.md) so the pool drains
on `app.stop()`:

```ts
import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';
import {eq} from 'drizzle-orm';
import {registerDrizzle, DrizzleBindings} from '@agentback/drizzle';
import * as schema from './db/schema.js';
import {users} from './db/schema.js';
import {
  USER_STORE,
  type UserStore,
  type NewUser,
  type User,
} from './user-store.js';

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

class PgUserStore implements UserStore {
  constructor(private db: AppDb) {}
  async create(input: NewUser): Promise<User> {
    const [row] = await this.db.insert(users).values(input).returning();
    return row;
  }
}

// in the application constructor, instead of the InMemoryUserStore binding:
const pool = new Pool({connectionString: process.env.DATABASE_URL});
registerDrizzle(this, drizzle(pool, {schema}), {onStop: () => pool.end()});
this.bind(USER_STORE).toDynamicValue(
  async ctx => new PgUserStore(await ctx.get(DrizzleBindings.CLIENT)),
);
```

The controller, the routes, the OpenAPI doc, and the MCP tool don't change —
only the store behind the port does. Migrations stay with `drizzle-kit` as a
dev dependency (`drizzle-kit generate` / `push`); the framework doesn't wrap
them.
