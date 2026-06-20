# hello-agent-console

Expose a running AgentBack app to your coding agent, read-only, so it can *see*
the live instance (bindings, schema, routes, tools) before it helps you *evolve*
the source.

```bash
pnpm -F hello-agent-console build
pnpm -F hello-agent-console start
# MCP (incl. introspection) is served at http://localhost:3000/mcp
```

Point your agent's MCP client at `http://localhost:3000/mcp`, then ask it to call
`inventory` / `get` / `get_okf_bundle`. It now answers questions about *this*
running app, not a guess from source.
