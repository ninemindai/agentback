# Package catalog

Every `@agentback/*` package and `create-agentback`, grouped by layer.
Each package also ships its own `README.md` under [`packages/`](../packages/).

## DI foundation

| Package               | Role                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `@agentback/common`   | Shared logging, env, ID, redaction, and async helper utilities                                       |
| `@agentback/metadata` | Decorator metadata utilities (port of `@loopback/metadata`)                                          |
| `@agentback/context`  | DI container: `Context`, `Binding`, `@inject`, providers, interceptors (port of `@loopback/context`) |
| `@agentback/core`     | `Application` (a `Context`), `Component`, `Server`, life-cycle (port of `@loopback/core`)            |

## REST, MCP, and clients

| Package                       | Role                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentback/http-server`      | HTTP server with graceful stop (port of `@loopback/http-server`)                                                                                                                          |
| `@agentback/middleware`       | Runtime-neutral middleware-chain machinery (Express-free; shared by `rest` + the Express host)                                                                                            |
| `@agentback/express`          | Optional Express **host** (`ExpressService`, the LB middleware chain over `express`/`cors`)                                                                                               |
| `@agentback/openapi`          | Zod-first decorators + OpenAPI 3.1.1 emission                                                                                                                                             |
| `@agentback/rest`             | REST server (Zod validation); `RestApplication`/`ExpressRestApplication` (Express) + `EdgeRestApplication` (fetch/Workers, no `express` install)                                          |
| `@agentback/rest-explorer`    | Mounts Swagger UI 5.x at `/explorer`                                                                                                                                                      |
| `@agentback/context-explorer` | Mounts a context/binding explorer UI                                                                                                                                                      |
| `@agentback/schema-explorer`  | Mounts a schema/entity provenance explorer UI (REST + MCP + Drizzle); exports the graph as an OKF knowledge bundle (`buildOkfBundle`, Knowledge tab)                                      |
| `@agentback/introspection`    | Read-only MCP server exposing the live app (bindings/schema/routes/tools + OKF) to any agent via a selector surface (`inventory`/`get`/`list_okf_files`/`get_okf_files`/`get_okf_bundle`) |
| `@agentback/mcp`              | Decorator-driven MCP server (`@mcpServer`, `@tool` w/ Zod input/output; serves `2026-07-28` + 2025 over stdio by default)                                                                 |
| `@agentback/mcp-inspector`    | Mounts an MCP inspector UI at `/mcp-inspector`                                                                                                                                            |
| `@agentback/mcp-http`         | Exposes the MCP server over Streamable HTTP at `/mcp` (+ OAuth, scopes; stateless `2026-07-28` + 2025 serving by default)                                                                 |
| `@agentback/mcp-client`       | Connect to remote MCP servers over HTTP (OAuth-aware)                                                                                                                                     |
| `@agentback/mcp-host`         | Aggregate upstream MCP servers into one gateway                                                                                                                                           |
| `@agentback/mcp-connect`      | Persistent outbound MCP connections for browser/admin UIs                                                                                                                                 |
| `@agentback/client`           | Schema-shared typed HTTP client with no codegen                                                                                                                                           |

## Platform components

| Package                            | Role                                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentback/config`                | Zod-validated config loader with env overlays and DI bindings                                                                                       |
| `@agentback/security`              | User, subject, and principal primitives                                                                                                             |
| `@agentback/authentication`        | Authentication decorator and strategy pipeline                                                                                                      |
| `@agentback/authentication-jwt`    | JWT bearer strategy                                                                                                                                 |
| `@agentback/authentication-oauth2` | OAuth2 introspection and JWKS bearer-token strategies                                                                                               |
| `@agentback/authorization`         | `@authorize` decorator and voter pipeline                                                                                                           |
| `@agentback/extension-health`      | Health/readiness probes                                                                                                                             |
| `@agentback/extension-metrics`     | Prometheus `/metrics` endpoint and HTTP timing                                                                                                      |
| `@agentback/extension-otel`        | OpenTelemetry spans across REST, MCP, and jobs                                                                                                      |
| `@agentback/extension-rate-limit`  | In-memory or Redis-backed rate limiting                                                                                                             |
| `@agentback/metering`              | Per-principal REST/MCP/agent usage events, audit sinks, and quota                                                                                   |
| `@agentback/agents`                | Opt-in AI SDK agent wiring — `@tool` classes projected as host-executed agent tools, per-turn identity, sessions, metering                          |
| `@agentback/payments`              | x402/MPP/Stripe payment authorization and billing seams                                                                                             |
| `@agentback/messaging`             | Zod-typed JobQueue/EventBus/Scheduler ports with in-memory adapter                                                                                  |
| `@agentback/messaging-bullmq`      | BullMQ + Redis Streams durable adapter for messaging ports                                                                                          |
| `@agentback/actors`                | Zod-typed actor runtime port — `@actor`/`@actorCommand`, per-identity serialized turns, idempotent replay, in-memory adapter                        |
| `@agentback/actors-do`             | Durable Objects actor runtime adapter — one object per identity on Cloudflare DO or celld, atomic state/dedup/journal commit, in-process host       |
| `@agentback/actors-redis`          | Redis-backed actor runtime adapter — per-identity leases, atomic state/dedup/journal commit, at-least-once journal delivery                         |
| `@agentback/drizzle`               | Drizzle ORM binding and drizzle-zod recipe                                                                                                          |
| `@agentback/files`                 | `FileStore` port for uploads/downloads + in-memory adapter (the disk `FsFileStore` is the Node-only `@agentback/files/fs` subpath)                  |
| `@agentback/files-s3`              | S3 `FileStore` adapter (streaming via AWS SDK v3)                                                                                                   |
| `@agentback/files-sdk`             | `FileStore` adapter over [files-sdk](https://files-sdk.dev) — one port, 40+ storage backends (S3, R2, GCS, Azure, fs, …)                            |
| `@agentback/plugin`                | Discover, gate, mount **and retract** third-party `Component` packages; `provides`/`inject` derive mount order                                      |
| `@agentback/testing`               | Test harness with typed REST client, supertest, and in-memory MCP                                                                                   |
| `@agentback/testlab`               | Lower-level test helpers used by the package test suites                                                                                            |
| `create-agentback`                 | `npm create` scaffold for REST, MCP, and hybrid services                                                                                            |
| `@agentback/cli`                   | `agentback`/`abc` lifecycle CLI — `new` (scaffold), `deploy` (Vercel/Cloudflare Workers), `update` (bump lockstep ranges + run migrations)          |
| `@agentback/command`               | Project `@tool` classes as an operator CLI — argv→Zod coercion, bare stdout result, routed through `callTool` (shares tool selection with `agents`) |
| `@agentback/console`               | Combined context, schema, REST/OpenAPI, and MCP admin console                                                                                       |
| `@agentback/console-theme`         | Shared styling for console and explorer UIs                                                                                                         |
| `@agentback/console-agents`        | Console **Agent** tab: runs one turn of the app's own agent against its own `@tool`s, server-side (off by default)                                  |
| `@agentback/console-chat`          | ACP agent dock for the console: see the live app + evolve source via a grounded coding-agent session (Node-host-only; off by default)               |
