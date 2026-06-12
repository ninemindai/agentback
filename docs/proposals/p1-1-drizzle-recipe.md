# Proposal P1-1: Ship `@agentback/drizzle` (the blessed DB recipe)

**Status:** Implemented (2026-06-10). Scopes phase 1 of the decision drafted
in [docs/db-story.md](../db-story.md) — read that first; this proposal only
fixes the concrete package surface.

## Motivation

Every FastAPI (SQLModel) and NestJS (TypeORM/Prisma) refugee asks "where's my
ORM?" first. `db-story.md` already argues the answer — Drizzle, because
`drizzle-zod` extends the one-artifact property down to the table — and rules
out porting `@loopback/repository`. What remains is shipping the ~100 LoC
integration so the recipe is installable rather than aspirational.

## Package surface

```ts
// app wiring
import {registerDrizzle, DrizzleBindings} from '@agentback/drizzle';
import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';

const pool = new Pool({connectionString: DATABASE_URL});
registerDrizzle(app, drizzle(pool, {schema}), {onStop: () => pool.end()});

// controller
constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}
```

- `DrizzleBindings.CLIENT` — `BindingKey<unknown>` with a documented
  app-level type alias pattern (`type AppDb = NodePgDatabase<typeof schema>`).
  The framework does **not** depend on a specific driver: `drizzle-orm` is a
  peer dependency; the app passes an already-constructed client.
- `registerDrizzle(app, client, {key?, onStop?})`:
  binds the client (SINGLETON), and when `onStop` is provided registers a
  lifecycle observer so `app.stop()` drains the pool — the piece people
  forget and the reason this is a package, not a doc snippet.
  Optional `key` supports multiple databases
  (`registerDrizzle(app, analyticsDb, {key: 'datasources.analytics'})`).
- Re-exports `createInsertSchema`/`createSelectSchema`/`createUpdateSchema`
  from `drizzle-zod` so app code has one import root and the version is
  centrally pinned against the workspace Zod major.

## Testing + example

- Unit: binding registered, lifecycle stop invokes `onStop` exactly once,
  multiple-db keys.
- Integration test + `examples/hello-drizzle` use the in-memory-friendly
  `drizzle-orm/libsql` (`:memory:`) or `better-sqlite3` driver so neither CI
  nor the example needs a database server; the README shows the Postgres
  wiring. Example: `users` table → `createInsertSchema` → `@post('/users')`
  body schema → same schema on a `@tool('create_user')` — table-to-MCP in one
  artifact chain.

## Out of scope

- Migrations tooling (drizzle-kit is the app's dev dependency; the guide
  shows the commands, the framework doesn't wrap them).
- MCP Toolbox integration (the federated-DB secondary recipe in db-story.md) —
  separate follow-up.
- Repository/unit-of-work abstractions — permanently out, per db-story.md.
