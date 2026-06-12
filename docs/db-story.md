# Proposal: Drizzle as the Blessed Database Recipe

**Status:** Drizzle recipe implemented; MCP Toolbox remains a follow-up proposal.
**Audience:** Framework contributors evaluating the DB story, and downstream users picking an ORM.
**Last revised:** 2026-06-10.
**Related:** [agent-ergonomics.md](agent-ergonomics.md) — the boundary-coherence thesis this builds on.

## TL;DR

The framework ships **`@agentback/drizzle`** — a thin DI integration around [Drizzle ORM](https://orm.drizzle.team) — as the blessed recipe for app-owned databases. The integration is small: a binding key, a lifecycle observer for pool shutdown, and a `/zod` subpath with `drizzle-zod` re-exports so route schemas derive from table schemas.

A secondary recipe is proposed for federated / enterprise databases via Google's [MCP Toolbox](https://github.com/googleapis/mcp-toolbox) — a separate service that exposes database operations as MCP tools. A LoopBack Agent wrapper for MCP Toolbox is not currently part of this repo.

We will **not** ship an in-house ORM, will **not** port `@loopback/repository`, will **not** introduce a `Filter<T>` / `Where<T>` query DSL, and will **not** generate clients from a non-TS schema language.

The choice of Drizzle is driven by **boundary coherence**: a Drizzle table declaration extends the framework's "one artifact, all boundaries" property one layer down to the database. The same TypeScript that defines the table generates the runtime row type, the Zod insert/select/update schemas, the `z.infer` parameter types on routes, the OpenAPI emission, and (when exposed via `@tool`) the MCP input/output. No codegen step, no DSL, no third-party Zod generator plugin.

## The decision

**Primary recipe: Drizzle ORM, integrated via `@agentback/drizzle`.**

```ts
// db/schema.ts — single source of truth
import {pgTable, serial, text, timestamp} from 'drizzle-orm/pg-core';
import {
  createInsertSchema,
  createSelectSchema,
} from '@agentback/drizzle/zod';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const NewUser = createInsertSchema(users, {
  email: schema => schema.email.email(),
});
export const User = createSelectSchema(users);
```

```ts
// controllers/users.controller.ts
import {z} from 'zod';
import {eq} from 'drizzle-orm';
import {api, get, post} from '@agentback/openapi';
import {inject} from '@agentback/context';
import {DrizzleBindings} from '@agentback/drizzle';
import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
import {NewUser, User, users} from '../db/schema.js';
import * as schema from '../db/schema.js';

@api({basePath: '/users'})
export class UsersController {
  constructor(
    @inject(DrizzleBindings.CLIENT)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  @get('/', {response: z.array(User)})
  async list(): Promise<z.infer<typeof User>[]> {
    return this.db.select().from(users);
  }

  @get('/{id}', {
    path: z.object({id: z.coerce.number().int()}),
    response: User,
    responses: {404: {description: 'Not found'}},
  })
  async getOne(input: {path: {id: number}}): Promise<z.infer<typeof User>> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, input.path.id));
    if (!row) throw createError(404, `User ${input.path.id} not found`);
    return row;
  }

  @post('/', {body: NewUser, response: User, status: 201})
  async create(input: {
    body: z.infer<typeof NewUser>;
  }): Promise<z.infer<typeof User>> {
    const [row] = await this.db.insert(users).values(input.body).returning();
    return row;
  }
}
```

**Secondary recipe: MCP Toolbox** — proposed for "I want to call a query that lives on another team's Toolbox server."

## What we ship

### `@agentback/drizzle` (primary, ~100 LoC)

A thin DI integration. Drizzle does the ORM work; this package does framework-shaped wiring.

**Exports:**

- `DrizzleBindings.CLIENT` — binding key for the Drizzle instance. Apps keep exact driver/schema types with a local type alias.
- `registerDrizzle(app, client, opts?)` — binds the client and, when `onStop` is supplied, registers a graceful-shutdown lifecycle observer.
- `@agentback/drizzle/zod` — optional subpath that re-exports `createInsertSchema`, `createSelectSchema`, and `createUpdateSchema` from `drizzle-zod`.

**Component contract:**

```ts
import {registerDrizzle} from '@agentback/drizzle';
import {drizzle} from 'drizzle-orm/node-postgres';
import {Pool} from 'pg';
import * as schema from './db/schema.js';

const pool = new Pool({connectionString: process.env.DATABASE_URL});
const db = drizzle(pool, {schema});

registerDrizzle(app, db, {onStop: () => pool.end()});
```

The factory is generic over the Drizzle dialect (`NodePgDatabase`, `BetterSQLite3Database`, `MySql2Database`, …) so users keep precise types in their controllers. The package itself doesn't pick a database driver.

**What the component does internally:**

1. Binds the client value under `DrizzleBindings.CLIENT` or a caller-supplied key.
2. Registers a `LifeCycleObserver` whose `stop()` calls the user-supplied `onStop()`. This ensures pools close on `app.stop()` rather than leaking on test shutdown or graceful-restart.

That's the whole abstraction.

### Proposed MCP Toolbox integration (secondary, ~150 LoC)

A thin wrapper around `@toolbox-sdk/core` for the federated-DB-as-MCP-tools case.

**Exports:**

- `ToolboxBindings.CLIENT` — the configured `ToolboxClient`.
- `ToolboxBindings.TOOLS` — a `Map<string, Tool>` of loaded tools, populated at start.
- `toolboxComponent(opts)` — factory that binds the client and registers a lifecycle observer that connects + loads the requested toolset on `app.start()`.
- Optional: re-expose loaded Toolbox tools as MCP tools on the framework's own `MCPServer` (so an MCP client connecting to your app sees both your business tools and your DB-via-Toolbox tools).

**Component contract:**

```ts
// Pseudocode: this wrapper is proposed, not shipped today.

app.component(
  toolboxComponent({
    url: process.env.TOOLBOX_URL ?? 'http://localhost:5000',
    toolset: 'production-queries',
    // Optional: re-expose loaded tools through our own MCPServer
    exposeAsMcp: true,
  }),
);
```

Controllers `@inject(ToolboxBindings.TOOLS)` and call individual tools by name.

### Examples

- **`examples/hello-drizzle`** — full Drizzle setup with SQLite in-memory database, table schema, `createInsertSchema`/`createSelectSchema`, three CRUD routes, a tiny migration runner, and tests that demonstrate binding swap for repository-style isolation.
- **`examples/hello-toolbox`** — proposed follow-up example for a controller calling a Toolbox-exposed query.

## What we don't ship

These are explicit non-goals; the design rejects them.

- **No in-house ORM.** Drizzle does ORMs better than we would.
- **No port of `@loopback/repository` or `juggler`.** Both are large surfaces with weak TS stories that mismatch the framework's small-surface, Zod-first thesis. Reintroducing them would be the same kind of decision we already rejected with sequences/actions.
- **No `Filter<T>` / `Where<T>` query language.** Drizzle's typed query builder is what users get. Stringly-typed query languages are the opposite of boundary coherence.
- **No `@model` / `@property` decorators with `@AgentBack`-namespaced metadata.** Drizzle's `pgTable(...)` syntax is the schema; we don't reinvent it.
- **No in-house migration tool.** `drizzle-kit` exists, is well-maintained, and produces TS migration files. The framework's CLI (if and when it appears) might wrap it, but won't replace it.
- **No support for the Prisma client out of the box.** Users who prefer Prisma can wire it themselves under the same DI patterns (bind `PrismaClient` to a context key, register a `LifeCycleObserver` for `$disconnect`) — but we don't ship a Component for it. A short "alternative ORMs" section in the README documents the pattern.

## How this fits the boundary-coherence thesis

The framework's distinctive value is that every API boundary (runtime, type, OpenAPI, MCP, docs) is derivable from the same Zod schema declared on a verb/tool decorator. Drizzle extends this property one layer further:

```
pgTable('users', {...})              ← one table definition
  ├─ drizzle row type                ← TS type for DB operations
  ├─ createInsertSchema(users)       ← Zod schema for inserts
  ├─ createSelectSchema(users)       ← Zod schema for selects
  ├─ createUpdateSchema(users)       ← Zod schema for updates
  └─ used as @post({body: ...})      ← route contract, automatically:
        ├─ runtime validator (Zod safeParse)
        ├─ TS parameter type (z.infer)
        ├─ OpenAPI requestBody / response
        └─ MCP inputSchema / outputSchema (if exposed via @tool)
```

A user reading `users.controller.ts` sees `User` and `NewUser` and knows they come from `users` in `db/schema.ts` — one click away, no codegen folder to navigate.

A user **changing** the table — adding a column, renaming a field, tightening a constraint — does it once in `db/schema.ts`. TypeScript flags every dependent file. Tests fail loudly. The OpenAPI doc updates on the next request to `/openapi.json`. No drift between "what the DB has," "what the validator accepts," "what the type says," and "what the docs claim."

Compare to a Prisma stack:

```
schema.prisma                        ← .prisma DSL (non-TS)
  ↓ prisma generate                  ← codegen step #1
@prisma/client types
  ↓ prisma-zod-generator             ← codegen step #2 (third-party plugin)
generated Zod schemas
  └─ used as @post({body: ...})
```

Three artifacts, two codegen steps, drift opportunities at each transition. Forget to run `prisma generate` after a `schema.prisma` edit and TS won't catch it. The chain works, but it works _despite_ the codegen step, not because of it.

For an agent-led codebase, the "forgot to regenerate" failure mode is recurrent. Drizzle eliminates the failure mode by not having the step.

## Migration story

Migrations live under `db/migrations/` as TS files generated by [`drizzle-kit`](https://orm.drizzle.team/kit-docs/overview). The recipe is standard Drizzle:

```bash
# Initial schema → migration files
pnpm drizzle-kit generate

# Apply pending migrations
pnpm drizzle-kit migrate

# For development: push schema directly without migrations
pnpm drizzle-kit push
```

We do **not** ship migration tooling of our own. We do **not** auto-run migrations on `app.start()` (that's a deployment-policy decision, not a framework one). We do provide a documented helper for "run pending migrations from a lifecycle observer" if a user wants that behavior — but the default is "you run migrations as a deployment step."

Project layout convention (documented, not enforced):

```
src/
  db/
    schema.ts          ← source of truth (Drizzle tables + drizzle-zod schemas)
    migrations/        ← drizzle-kit output (committed to git)
      0000_init.sql
      0001_add_users_table.sql
      meta/
        _journal.json
    client.ts          ← creates the pool + drizzle instance
  controllers/
    users.controller.ts
drizzle.config.ts      ← drizzle-kit config (schema path, out dir, dialect)
```

## Testing story

Three patterns ship as documented recipes; the first is the recommended default.

### 1. In-memory SQLite with the real schema (recommended)

```ts
import {drizzle} from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {migrate} from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema.js';

beforeEach(async () => {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, {schema});
  migrate(db, {migrationsFolder: './src/db/migrations'});
  app = new RestApplication();
  app.component(drizzleComponent({client: db, shutdown: () => sqlite.close()}));
  // …
});
```

Real schema, real queries, deterministic. Fast enough for unit-test-like cycles. Works if you keep the schema dialect-agnostic (which Drizzle makes easy if you stick to portable column types).

### 2. Docker-compose Postgres for integration tests

Standard pattern; nothing framework-specific. Document the `docker-compose.test.yml` shape.

### 3. Bind a fake `db` for pure controller unit tests

```ts
app.bind(DrizzleBindings.CLIENT).to(stubDb);
```

For tests that don't care about query correctness, just controller logic. Works because the DI binding is swappable.

We won't ship a "test DB harness" — these patterns are 10 lines each and standard Drizzle usage.

## Multi-database support

Drizzle ships first-party drivers for Postgres (node-postgres, postgres-js, neon), MySQL (mysql2, planetscale), SQLite (better-sqlite3, libsql), and AWS Data API. Our package is generic over the driver — the user picks at app-init time. We don't add per-database support packages.

What we **do** document, for each blessed database:

- The driver to install.
- The `drizzle(...)` invocation shape.
- The pool / connection-management considerations (serverless vs long-running).
- The corresponding `drizzle-kit` config dialect.

That's a doc page (~50 lines per database), not code.

## Lifecycle and graceful shutdown

`registerDrizzle` registers a `LifeCycleObserver` whose `stop()` calls the user-supplied `onStop` callback. This means:

- `await app.stop()` closes the pool.
- Tests that `afterEach(() => app.stop())` don't leak connections.
- Production processes shutting down on `SIGTERM` close cleanly.

If the user omits `onStop`, no observer is registered (some drivers like `better-sqlite3` are synchronous and don't need it; others do).

## Alternatives considered (and why we rejected them)

### Port `@loopback/repository`

What it would give us: comprehensiveness, familiarity for LB4 users.

Why we rejected it:

- The surface is enormous — `juggler`, connectors, `Filter<T>`/`Where<T>`, `DefaultCrudRepository<T, ID, Relations>` plus N specialization types. The framework's small-surface thesis would be broken.
- Type safety is weak — string-keyed filters, runtime-only operator validation.
- Doesn't compose with our Zod-first thesis. Reintroducing it would create a parallel schema source of truth (model decorators vs Zod schemas).
- We already declared it out-of-scope in the README. That was the right call; this proposal continues it.

### Prisma

What it would give us: best-in-class generated types, mature migration tooling, much larger AI training corpus.

Why we rejected it as primary:

- Schema lives in a non-TS DSL (`schema.prisma`). Breaks the "everything in TS" property at the database layer.
- Two codegen steps to reach Zod (`prisma generate` + `prisma-zod-generator`). Three artifacts to keep coherent.
- The codegen step is a recurrent agent footgun ("forgot to regenerate after schema change").
- Heavier runtime than Drizzle (Rust query engine or driver adapter, plus generated client).

Prisma remains a fully supported alternative — we document the recipe in the README and ship no Component, just the pattern. Teams migrating from NestJS+Prisma can keep using Prisma; the framework's DI patterns handle it identically.

### TypeORM

What it would give us: largest legacy install base in the Nest world.

Why we rejected it:

- TS types are historically weak (relations, partial updates, `Partial<Entity>` patterns).
- Active-record style fights the framework's "controllers are bindings, services are bindings" composition.
- The community is migrating away from TypeORM toward Prisma and Drizzle; betting on it would be backward-looking.

### Sequelize / MikroORM

Considered briefly. Neither materially better than the alternatives above for our specific thesis. Neither shipped as a recipe; users wiring them in get the same DI patterns.

### MCP Toolbox as the _only_ DB story

What it would give us: zero ORM code to maintain, multi-database support for free, federated queries, no in-app schema.

Why we rejected it as primary (but kept as secondary):

- Latency: every query is a network hop through the Toolbox server.
- Queries are predefined in `tools.yaml`. No ad-hoc parameterized queries from app code.
- Loses end-to-end TS type safety — the type contract is Toolbox's tool schema, not your table schema.
- Wrong fit for "I want a local Postgres for my app's primary data."

It's the right tool for cross-team, cross-database, cross-language federated access — which is why it ships as a separate recipe.

### Kysely

A pure query builder, no schema-as-TS, no migration tooling. Drizzle is a superset for our purposes (it does query-building too) plus brings migrations and drizzle-zod. No reason to pick Kysely over Drizzle for this specific thesis.

## Implementation plan

### Phase 1 — `@agentback/drizzle` (implemented)

- New workspace package `packages/drizzle/`.
- `DrizzleBindings.CLIENT` binding key.
- `registerDrizzle(app, client, {key?, onStop?})`.
- Re-export `drizzle-zod` helpers from the `/zod` subpath.
- Unit tests: client binding, multiple keys, lifecycle observer calls `onStop` once.
- README + JSDoc.

### Phase 2 — `examples/hello-drizzle` (follow-up)

A working end-to-end example:

- SQLite in-memory (no external DB needed for `pnpm test`).
- `db/schema.ts` with one table.
- `drizzle.config.ts` (so users can copy the pattern).
- A CRUD controller using `createInsertSchema` / `createSelectSchema`.
- Tests demonstrating the route + DB integration.

### Phase 3 — MCP Toolbox integration (follow-up)

- New workspace package `packages/mcp-toolbox/`.
- `ToolboxBindings.CLIENT` / `ToolboxBindings.TOOLS`.
- `toolboxComponent({url, toolset, exposeAsMcp?})`.
- Lifecycle observer connects + loads toolset on start, disconnects on stop.
- Optional MCP re-exposure path: register each Toolbox tool as an `MCPServer` tool with the same input/output schemas.
- Tests: mock Toolbox server with `@modelcontextprotocol/sdk` and verify tools are loaded + invoked.

### Phase 4 — `examples/hello-toolbox` (week 2, parallel)

A working federated-DB example. Likely against a public Toolbox demo deployment or a docker-compose Toolbox + Postgres.

### Phase 5 — Documentation (week 2 cleanup)

- Add a "Database" section to README, pointing at both recipes.
- Update CLAUDE.md's "available now" list.
- Extend `docs/agent-ergonomics.md` with a short "Database boundary" subsection that points at `db-story.md` and reaffirms how Drizzle extends the boundary-coherence property.
- Remove `@loopback/repository` references from non-goals (they're already absent, but worth a doc sweep).

### Out of scope for this proposal

- Auto-emitting routes from a Drizzle schema (`createCrudController(users, {basePath: '/users'})` style sugar). Possible later; not load-bearing for the recipe.
- Drizzle relations API integration with OpenAPI `$ref` emission. The current `drizzle-zod` story handles flat row schemas cleanly; relations produce nested objects that emit fine but might benefit from `$ref` reuse in the OpenAPI doc.
- Multi-tenant query helpers. Standard Drizzle patterns work today.
- Connection-string-from-config conveniences. Trivial for users; not worth a framework abstraction.

## Open questions

1. **Should the component accept a factory instead of a pre-built client?** Currently the user builds `drizzle(pool, {schema})` and passes it in. An alternative is `drizzleComponent({factory: (ctx) => drizzle(pool)})` — factory has access to the application context, which might be useful for config-driven pool setup. **Recommendation:** ship both. The plain `client:` form is simpler; the `factory:` form is for users who need context access.

2. **Should we re-expose `drizzle-kit` migrations through a framework command?** E.g., a built-in `app.runMigrations()` or `pnpm -F hello-drizzle migrate`. **Recommendation:** no for v0. Migrations are a deployment-policy concern, and the framework has historically avoided becoming a CLI host.

3. **What about Drizzle's "active query" / live updates story?** Drizzle is exploring reactive query subscriptions. **Recommendation:** track upstream; nothing in our framework precludes their integration when it lands.

4. **Should the MCP Toolbox integration be in the framework repo or a separate package?** The same question applies to all third-party-service integrations. **Recommendation:** in-repo for v0 so it benefits from the workspace's build/lint/test infrastructure. If/when integrations proliferate, factor them out.

5. **How do we handle the `drizzle-zod` version drift question?** `drizzle-zod` is a small package but versions can lag behind Drizzle. **Recommendation:** pin both deps as peer-deps of `@agentback/drizzle` and document compatible version ranges in the package README. Same approach as the `@modelcontextprotocol/sdk` peer-dep on `@agentback/mcp`.

6. **Does Drizzle's experimental "RQB" (Relational Queries Builder) interact with the Zod story?** RQB returns nested relation objects; `drizzle-zod` doesn't currently auto-derive Zod schemas for nested relation results. **Recommendation:** initial recipe sticks to `db.select()` / `db.insert()` / `db.update()` flat-row patterns. RQB integration is a follow-up if user demand emerges.

## Decision criteria checklist

A new database integration is considered a candidate for first-class support if and only if:

1. **Schema lives in TypeScript.** No external DSL files for the schema.
2. **Type derivation is runtime or zero-step.** Generated clients with required codegen steps fail this check.
3. **Native Zod schema derivation.** Either built-in (Drizzle's `drizzle-zod`) or trivially derivable (`z.object` from the type). Third-party generators with significant version drift fail.
4. **Compatible with our DI patterns.** Binds cleanly to a context, supports lifecycle observers, doesn't require app subclassing.
5. **Maintains the framework's small surface.** A new integration that requires 10+ packages or a separate CLI fails.

Drizzle passes all five. Prisma fails (1) and (2). TypeORM fails (3) and (4). `@loopback/repository` fails (1), (3), and (5). MCP Toolbox passes (4) and (5) but doesn't meet (1)–(3) because it lives out-of-process — which is why it ships as a secondary recipe, not as the primary database story.

## References

- Drizzle ORM: https://orm.drizzle.team
- `drizzle-zod`: https://orm.drizzle.team/docs/zod
- `drizzle-kit`: https://orm.drizzle.team/kit-docs/overview
- MCP Toolbox: https://github.com/googleapis/mcp-toolbox
- `@toolbox-sdk/core`: https://github.com/googleapis/mcp-toolbox-sdk-js/tree/main/packages/toolbox-core
- The boundary-coherence thesis this builds on: [agent-ergonomics.md](agent-ergonomics.md)
