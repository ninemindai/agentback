# @agentback/schema-explorer

A read-only web UI + JSON API that indexes an AgentBack app **by schema** instead
of by protocol. Where `rest-explorer` (Swagger) and `mcp-inspector` answer
_"given this endpoint, what's its shape?"_, schema-explorer answers the inverse:

> _"given this entity, **everywhere** is it used — which REST routes, which MCP
> tools, which database table?"_

That inverse index is where cross-cutting truth lives. It makes the framework's
single-source-of-truth thesis visible as a graph, and surfaces drift the
per-surface views structurally can't: an entity exposed over REST but not MCP, or
a registered schema nothing uses.

## How it works

Every Zod schema you declare on a `@get`/`@post` (`body`/`path`/`query`/
`headers`/`response`) or a `@tool` (`input`/`output`) is the **same object** on
both ends. schema-explorer:

1. **Discovers nodes** from the DI container — every `schema`-tagged binding
   (see [`bindSchema`](#registering-schemas) below) — giving each entity a stable
   name and, optionally, an origin (e.g. its Drizzle table).
2. **Draws edges** by inverting the REST route registry and MCP tool metadata and
   matching each slot to its schema **by object-reference identity** (`===`). The
   same `z.object(...)` shared by a route and a tool collapses to one node with
   two usages.

Schemas you never register still appear — discovered from the routes/tools that
use them — with a synthesized name and no origin. Registration is **opt-in
enrichment**, not a requirement.

## Usage

### Standalone

```ts
import {RestApplication} from '@agentback/rest';
import {installSchemaExplorer} from '@agentback/schema-explorer';

const app = new RestApplication({rest: {port: 3000}});
// … register controllers / tool classes …
await installSchemaExplorer(app); // UI at /schema-explorer, API at /schema-explorer/api
await app.start();
```

### In the unified console

`@agentback/console` includes the schema panel in its default features — no extra
wiring. It appears in the sidebar between Context and API.

## Registering schemas

Naming and origin are the two things an anonymous `z.object(...)` can't carry on
its own, so they're opt-in via a context binding:

```ts
import {bindSchema} from '@agentback/openapi';

const Greeting = z.object({message: z.string()});
bindSchema(app, 'Greeting', Greeting); // node named "Greeting"
```

A bound schema also shows up in `context-explorer`, so the wiring view and the
schema view reconcile.

### Drizzle origin

`drizzle-zod` produces a schema with no link back to its table, so the table name
must be captured where it's still in scope. Two ways:

```ts
// 1. Build + register in one call (schemas defined at app-setup time):
import {registerSelectSchema} from '@agentback/drizzle/zod';
const User = registerSelectSchema(app, users, 'User'); // tags table: 'users'

// 2. Enrich an existing module-level schema (the common case — schemas used by
//    decorators must exist before the app is constructed):
import {getTableName} from 'drizzle-orm';
import {bindSchema} from '@agentback/openapi';
bindSchema(app, 'User', User, {table: getTableName(users), kind: 'select'});
```

See `examples/hello-drizzle` for the second pattern end to end.

## OKF export (Knowledge tab)

The same schema graph serializes to an **[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
(Open Knowledge Format) bundle** — a portable, vendor-neutral directory of
markdown + YAML-frontmatter docs an agent can ingest verbatim or you can commit
to git. It's a sixth projection of the one source of truth (alongside OpenAPI,
MCP `inputSchema`, REST routes, Drizzle tables), aimed at *comprehension* rather
than the wire contract.

The bundle is two-tier and cross-linked:

- `schemas/<slug>.md` — one doc per entity. `type: table` when backed by a
  Drizzle table (else `type: reference`), a field table, and a "Used by" section
  linking the routes/tools that touch it.
- `surfaces/<slug>.md` — one `reference` doc per REST route / MCP tool, linking
  back to the schemas it consumes.
- auto `index.md` files (root + per tier) for progressive disclosure.

Output is **derived and emit-only**, deterministic (no timestamps, sorted), and
by default omits the framework's own dev-tooling controllers so a bundle
describes the app, not the explorer serving it.

The **Knowledge** tab browses the bundle (file tree + rendered markdown, with
in-tab cross-link navigation) and exports it as a directory-structured `.zip` or
a single concatenated `.md`. Programmatic access:

```ts
import {buildOkfBundle, inventoryToOkf} from '@agentback/schema-explorer';

const bundle = buildOkfBundle(app); // {files: [{path, content}]}
// or from a prebuilt inventory, with a custom exclude predicate:
const onlyRest = inventoryToOkf(inv, {exclude: s => s.surface === 'mcp'});
```

## API

| Route                         | Returns                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| `GET /schema-explorer/api/schemas` | Every schema node with its cross-protocol usages + fields |
| `GET /schema-explorer/api/graph`   | Schema nodes + surface (route/tool) nodes + role-labeled edges |
| `GET /schema-explorer/api/okf`     | The schema graph as an OKF bundle (`{files: [{path, content}]}`) |

## Notes

- `@agentback/mcp` is a regular dependency so the MCP leg works out of the box;
  in a REST-only app the MCP enumeration simply yields nothing.
- The view is read-only and side-effect free; the inventory is rebuilt per request
  from live registries, so it always reflects the running app.
