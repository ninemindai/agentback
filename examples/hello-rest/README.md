# hello-rest

> The AgentBack REST stack end-to-end: ESM + Zod + OpenAPI 3.1.1 + the full auth stack + health + Prometheus metrics.

One `RestApplication` that exercises schema-on-decorator routing (`@get`/`@post`
with `path`/`body`/`response` Zod schemas) plus JWT login with RBAC, anonymous,
api-key, and client-credentials strategies with client-app scope governance.

Schemas live in [`src/schemas.ts`](src/schemas.ts) so clients can import the
exact same `z.ZodType` contract without dragging in the server's controllers or
runtime — [`hello-client`](../hello-client) does exactly that. No codegen, no
drift.

## Run

```bash
pnpm build              # from the repo root
pnpm -F hello-rest start
```

## Surfaces

| Route                                     | What it shows                                          |
| ----------------------------------------- | ------------------------------------------------------ |
| `GET /hello/{name}`                       | path-schema validation                                 |
| `POST /echo`                              | body-schema validation                                 |
| `GET /stream/{name}`                      | typed SSE stream (`streamOf:` + per-item validation)   |
| `POST /login` → `GET /me` / `GET /secret` | JWT auth + role-based access                           |
| `GET /ping` / `GET /data`                 | anonymous & api-key strategies                         |
| `GET /orders`                             | client-credentials + scope governance                  |
| `/openapi.json`                           | OpenAPI 3.1.1 emitted straight from the Zod schemas    |
| `/explorer/`                              | Swagger UI (`@agentback/rest-explorer`)                |
| `/context-explorer/`                      | live DI-container view (`@agentback/context-explorer`) |
| `/health`, `/metrics`                     | health checks + Prometheus metrics                     |
