# hello-hybrid

> One app, one DI container, two protocols: the same service exposed as REST routes and MCP tools.

A single `RestApplication` hosts a REST controller (`@api` + `@get`/`@post`)
and an MCP tool class (`@mcpServer` + `@tool`, plus a prompt and a resource) —
both validated by the same Zod schemas. `installMcpHttp` mounts the MCP
Streamable HTTP transport on the same Express server the REST routes use.

## Run

```bash
pnpm build              # from the repo root
pnpm -F hello-hybrid start
```

## Surfaces

| Route                     | What it is                               |
| ------------------------- | ---------------------------------------- |
| `GET /greet/hello/{name}` | REST, path-schema validated              |
| `POST /greet/echo`        | REST, body-schema validated              |
| `POST /mcp`               | MCP Streamable HTTP (`echo`/`add` tools) |
| `GET /openapi.json`       | OpenAPI 3.1.1                            |
| `GET /explorer/`          | Swagger UI                               |
| `GET /mcp-inspector/`     | MCP Inspector UI                         |
