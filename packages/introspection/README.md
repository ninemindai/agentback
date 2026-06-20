# @agentback/introspection

A **read-only** MCP server that exposes a running AgentBack app to any agent, so
your coding agent can ground itself in the *live instance* — what's bound, the
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
await installMcpHttp(app);        // expose MCP over Streamable HTTP at /mcp
await app.start();
// Point your agent's MCP client at http://localhost:3000/mcp
```

## Tools

- `inventory(kind?)` — list the app's nodes (`binding` | `schema-entity` | `route` | `tool`); omit `kind` for all. Bindings are metadata only.
- `get({kind, id})` — fetch one node's detail by selector (the `id` comes from `inventory`; routes are `"GET /path"`). Bindings return metadata only.
- `get_okf_bundle()` — the OKF knowledge bundle (a portable, schema-indexed snapshot) for the agent to ingest.

Built on the same read-only builders as `@agentback/context-explorer` and
`@agentback/schema-explorer` (incl. its OKF export) — this package is the
agent-facing projection of those read APIs. See `examples/hello-agent-console`.
