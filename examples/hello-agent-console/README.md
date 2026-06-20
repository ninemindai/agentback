# hello-agent-console

The see-and-evolve loop: a running AgentBack app with the developer console
open, an introspection MCP surface so any agent can query the live app, and an
ACP agent dock inside `/console` so you can drive source evolution from a chat
that _knows_ the running state.

## What this example does

- **REST endpoint** — `GET /hello/{name}` (a real route so there is something
  to inspect).
- **Introspection MCP at `/mcp`** — `inventory`, `get`, `get_okf_bundle` tools
  backed by the live app; any external agent can connect here.
- **Developer console at `/console`** — context, schema, REST, and MCP explorer
  panels in a single shell.
- **Agent chat dock** — a right-column ACP chat grounded in the live app
  (hidden until `claude-agent-acp` is detected on PATH; shows install hint
  otherwise).

## Quick start

```bash
pnpm -F hello-agent-console build
pnpm -F hello-agent-console start
# REST:    http://localhost:3000/hello/world
# MCP:     http://localhost:3000/mcp
# Console: http://localhost:3000/console
```

## See — external agent grounding

Point any MCP client at `http://localhost:3000/mcp`. The `IntrospectionTools`
surface is mounted on the same `/mcp` endpoint as the app's business tools:

```ts
// In any terminal session:
// mcp connect http://localhost:3000/mcp
// > inventory()        → all bindings, schemas, routes, tools
// > get({kind:'route', id:'GET /hello/{name}'})
// > get_okf_bundle()   → the full OKF knowledge bundle
```

## Evolve — agent console dock

Install the reference ACP adapter:

```bash
npm install -g claude-agent-acp
```

Open `http://localhost:3000/console`. The **Chat** dock appears in the right
column. The agent sees the live app (OKF brief + live introspection queries),
can answer questions about it, and can edit source files with your approval.

The evolve loop:

1. Ask the agent to add a new route or change existing logic.
2. The agent edits source, shows a permission prompt for each file write.
3. Approve — the agent writes the file.
4. The dock shows "Rebuild & reconnect."
5. Run `pnpm -F hello-agent-console build` (or keep `build:watch` running).
6. Restart the process — the console re-grounds the session in the updated app.

## Security note

This example uses `unsafeAllowUnauthenticated: true` for local development.
The server binds to `127.0.0.1:3000` (loopback only). **Never use this flag
when binding to a non-loopback interface.** See `docs/guides/agent-console.md`
for the full security model.
