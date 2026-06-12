# @agentback/drizzle

Thin DI integration for [Drizzle ORM](https://orm.drizzle.team) — the blessed
database recipe (see [docs/db-story.md](../../docs/db-story.md)). Drizzle does
the ORM work; this package does the framework-shaped wiring: a binding key, a
lifecycle observer for pool shutdown, and `drizzle-zod` re-exports so route
schemas derive from table schemas.

The package is generic over the Drizzle dialect (`NodePgDatabase`,
`BetterSQLite3Database`, `MySql2Database`, …): `drizzle-orm` is a peer
dependency and the app passes an already-constructed client. No driver is
picked for you.

## Wiring (Postgres example)

```ts
import {Application} from '@agentback/core';
import {registerDrizzle, DrizzleBindings} from '@agentback/drizzle';
import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';
import * as schema from './db/schema.js';

const app = new Application();
const pool = new Pool({connectionString: process.env.DATABASE_URL});
registerDrizzle(app, drizzle(pool, {schema}), {onStop: () => pool.end()});
```

Inject it in a controller via an app-level type alias (the binding key is
typed `unknown` because the framework doesn't know your driver or schema):

```ts
import {inject} from '@agentback/context';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema.js';

export type AppDb = NodePgDatabase<typeof schema>;

export class UsersController {
  constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}
}
```

## Multiple databases

Pass a distinct `key` per datasource; `DrizzleBindings.datasource(name)`
derives `datasources.<name>`:

```ts
registerDrizzle(app, primaryDb, {onStop: () => primaryPool.end()});
registerDrizzle(app, analyticsDb, {
  key: DrizzleBindings.datasource('analytics'), // 'datasources.analytics'
  onStop: () => analyticsPool.end(),
});

// injection site
constructor(
  @inject(DrizzleBindings.datasource('analytics')) private analytics: AnalyticsDb,
) {}
```

A plain string key (`{key: 'datasources.analytics'}`) works too.

## Lifecycle: why `onStop` matters

When `onStop` is provided, `registerDrizzle` registers a lifecycle observer so
`await app.stop()` drains the pool — the piece people forget and the reason
this is a package, not a doc snippet. Concretely:

- tests that `afterEach(() => app.stop())` don't leak connections;
- production processes shutting down on `SIGTERM` close cleanly;
- the callback runs **at most once**, even across repeated `app.stop()` calls
  or start/stop cycles (pools can't be re-opened after `end()`).

If you omit `onStop`, no observer is registered — synchronous drivers like
`better-sqlite3` may not need one.

## Table → Zod → route/tool: the one-artifact chain

`drizzle-zod` derives Zod schemas straight from the table declaration, so the
same artifact drives the row type, the runtime validator, the OpenAPI doc,
and the MCP tool schema. The re-exports live on the **`/zod` subpath**:

```ts
// db/schema.ts — single source of truth
import {pgTable, serial, text} from 'drizzle-orm/pg-core';
import {
  createInsertSchema,
  createSelectSchema,
} from '@agentback/drizzle/zod';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
});

export const NewUser = createInsertSchema(users);
export const User = createSelectSchema(users);
```

```ts
// controllers/users.controller.ts — same schemas on REST and MCP
import {post} from '@agentback/openapi';
import {tool} from '@agentback/mcp';
import {z} from 'zod';
import {eq} from 'drizzle-orm';
import {NewUser, User, users} from '../db/schema.js';

@post('/users', {body: NewUser, response: User, status: 201})
async create(input: {body: z.infer<typeof NewUser>}) {
  const [row] = await this.db.insert(users).values(input.body).returning();
  return row;
}

@tool('create_user', {input: NewUser, output: User})
async createUser(input: z.infer<typeof NewUser>) {
  const [row] = await this.db.insert(users).values(input).returning();
  return row;
}
```

### Why a subpath, not the main index?

`drizzle-zod` is an **optional** peer dependency. A static re-export from the
main index would make `import {registerDrizzle} from '@agentback/drizzle'`
fail with `ERR_MODULE_NOT_FOUND` in apps that don't install `drizzle-zod`.
Keeping the re-exports on `@agentback/drizzle/zod` means:

- `registerDrizzle` / `DrizzleBindings` work with `drizzle-orm` alone;
- importing the `/zod` subpath requires `drizzle-zod` (install it next to
  `drizzle-orm`; this package pins the compatible range as a peer).

## Testing your app

Bind a fake for pure controller unit tests — the DI binding is swappable:

```ts
app.bind(DrizzleBindings.CLIENT).to(stubDb);
```

Or use in-memory SQLite with the real schema
(`drizzle-orm/better-sqlite3` + `new Database(':memory:')`) for fast
integration-style tests without a database server.

## Out of scope

Migrations stay with `drizzle-kit` as an app dev dependency
(`drizzle-kit generate` / `migrate` / `push`); the framework doesn't wrap
them and doesn't auto-run them on `app.start()`. No repository/unit-of-work
abstractions, no `Filter<T>`/`Where<T>` DSL — see
[docs/db-story.md](../../docs/db-story.md) for the rationale.
