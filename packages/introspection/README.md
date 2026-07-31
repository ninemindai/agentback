# @agentback/introspection

A **read-only** MCP server that exposes a running AgentBack app to any agent, so
your coding agent can ground itself in the _live instance_ — what's bound, the
real schema graph, the routes and tools — instead of guessing from source.

> Read-only forever: it NEVER invokes a route or tool, and NEVER resolves a
> secret-bearing binding value (bindings are metadata only). The one resolution
> it does is reading schema-tagged bindings' Zod objects, exactly as
> `@agentback/schema-explorer` already does — schemas are not secrets. "Evolve
> the app" happens through the agent editing source, not through this surface.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {IntrospectionTools} from '@agentback/introspection';

const app = new RestApplication();
app.component(MCPComponent);
app.service(IntrospectionTools); // adds the introspection tools to the MCP surface
await installMcpHttp(app); // expose MCP over Streamable HTTP at /mcp
await app.start();
// Point your agent's MCP client at http://localhost:3000/mcp
```

## Tools

- `inventory(kind?)` — list the app's nodes (`binding` | `schema-entity` | `route` | `tool`); omit `kind` for all. Bindings are metadata only.
- `get({kind, id})` — fetch one node's detail by selector (the `id` comes from `inventory`; routes are `"GET /path"`). Bindings return metadata only.
- `list_okf_files()` — the OKF bundle's table of contents: every document's path, title, description and byte size, without the bodies. **Start here.**
- `get_okf_files({paths})` — fetch chosen documents by path. Batch every path you need into one call.
- `get_okf_bundle()` — the whole OKF knowledge bundle in one payload. The escape hatch when you genuinely want everything; on a non-trivial app prefer list + fetch, which is what OKF's progressive disclosure is for.

Built on the same read-only builders as `@agentback/context-explorer` and
`@agentback/schema-explorer` (incl. its OKF export) — this package is the
agent-facing projection of those read APIs. See `examples/hello-agent-console`.
