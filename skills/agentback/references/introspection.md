# Introspection (`@agentback/introspection`)

A **read-only** MCP server that exposes a running AgentBack app to any agent, so
a coding agent can ground itself in the *live instance* instead of guessing from
source. It is the agent-facing projection of the context/schema explorers.

## When to use

- You want your existing agent (terminal Claude Code, Cursor, an A2A peer) to
  answer questions about the *live* app: what's bound, the real schema graph,
  which routes and tools exist.
- You do NOT need the agent to mutate anything through this surface — it is
  read-only. The agent evolves the app by editing source, not via these tools.

## Wiring

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {IntrospectionTools} from '@agentback/introspection';

const app = new RestApplication();
app.component(MCPComponent);
app.service(IntrospectionTools); // registers the introspection tools
await installMcpHttp(app);        // serves MCP (incl. these tools) at /mcp
await app.start();
```

Point the agent's MCP client at `http://localhost:3000/mcp`.

## Tools

- `inventory(kind?)` — unified node list across kinds: `binding`, `schema-entity`,
  `route`, `tool`. Pass `kind` to filter. Bindings are metadata only. Route ids
  are `"VERB /path"` (verb uppercased, e.g. `"GET /hello"`).
- `get({kind, id})` — one node's detail by selector; `id` comes from `inventory`.
  Bindings return metadata (key/scope/type/tags/source), never a resolved value.
  Unknown id → `AgentError` 404 `not_found`.
- `get_okf_bundle()` — the OKF knowledge bundle (`{files: {path, content}[]}`),
  a portable schema-indexed snapshot for the agent to ingest.

## Invariants

- **Never invokes** a route or tool.
- **Never resolves a secret-bearing binding value** — bindings are metadata-only
  via `buildModel`. The only resolution is reading schema-tagged bindings' Zod
  objects (via `buildSchemaInventory`), exactly as `@agentback/schema-explorer`
  already does; schemas are not secrets.
- Builder failures surface as a named `AgentError` (500), not a redacted 500.

See `examples/hello-agent-console` for a runnable wiring.
