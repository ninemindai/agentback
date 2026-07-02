# hello-console

> The unified developer console: context explorer + REST/OpenAPI explorer + MCP inspector composed behind one shell at `/console`.

A hybrid REST + MCP app (same `echo`/`add` shape as
[`hello-hybrid`](../hello-hybrid)) where a single `installConsole(app, {...})`
call mounts every dev surface under one UI instead of installing each explorer
separately.

## Run

```bash
pnpm build              # from the repo root
pnpm -F hello-console start
```

Then open <http://127.0.0.1:3000/console/>.

## Surfaces

| Route                         | What it is                       |
| ----------------------------- | -------------------------------- |
| `GET /console/`               | the unified console shell        |
| `GET /context-explorer/api/*` | context panel API (DI bindings)  |
| `GET /explorer/`              | REST panel (Swagger UI, iframed) |
| `GET /mcp-inspector/api/*`    | MCP panel API                    |
| `POST /mcp`                   | MCP Streamable HTTP transport    |
