---
name: agentback
description: >-
  Build HTTP (REST) and MCP services from one Zod schema set and one DI
  container with AgentBack — an ESM/Zod/MCP fork of LoopBack 4. Use when
  building TypeScript/Node.js apps with @agentback/* packages: Zod-first
  REST controllers (@api, @get/@post/... with path/query/body/response schemas),
  MCP tool servers (@mcpServer, @tool with input/output schemas), OpenAPI 3.1
  emission, a schema-typed HTTP client, authentication strategies / @authorize
  voters, rate limiting, MCP-over-HTTP auth, or the agent runtime. Triggers on
  @agentback/core, RestApplication, MCPApplication, @api, @get, @tool,
  @mcpServer, installMcpHttp, @authenticate, @authorize, z.infer, or building a
  hybrid REST+MCP app where both ends share the same Zod schemas. Also covers
  scaffolding a new app with `npm create agentback` / the `create-agentback`
  CLI (rest | mcp | hybrid templates).
---

# Build REST + MCP Services with AgentBack

`AgentBack` is an **ESM/Zod/MCP fork of LoopBack 4** — a TypeScript DI
framework (`@agentback/core` + `@agentback/context`) with HTTP and MCP
servers that discover your code by tag in one `Context`. Its bet: **a single Zod
schema is the validator, the `z.infer` type, the OpenAPI contract, the MCP
input/output, and the rendered docs — simultaneously.** Change the schema and
every contract changes in one edit; disagreements surface as a TypeScript error
at the decorator, a startup throw, or a failing test.

ESM-only, Node 22.13+, TypeScript 6, pnpm workspaces. **Relative imports use
`.js` extensions.** This is a slim modern subset — no LB4 sequences/actions, no
`@loopback/repository`, no per-parameter `@param`/`@requestBody`.

## Architecture Decision Tree

1. **DI container, bindings, components, lifecycle?** → Dependency injection &
   components ([dependency-injection.md](references/dependency-injection.md)).
   (Same model as `@loopback/core`; this layer is a faithful port.)
2. **HTTP/REST API with validation + OpenAPI?** → Zod-first REST
   ([rest-and-openapi.md](references/rest-and-openapi.md))
3. **Tools / resources / prompts for MCP clients (Claude, Cursor, agents),
   over stdio or HTTP?** → MCP tools ([mcp-tools.md](references/mcp-tools.md))
4. **Share schemas/types between server and a typed client (no codegen)?** →
   Schema sharing & client ([schema-sharing-and-client.md](references/schema-sharing-and-client.md))
5. **Authentication, authorization, scopes, rate limiting (REST or MCP/HTTP)?**
   → Auth & rate limiting ([auth-and-rate-limiting.md](references/auth-and-rate-limiting.md))
6. **Health/metrics, middleware, subclassing the dispatcher, packaging?** →
   Composition & operations ([composition-and-operations.md](references/composition-and-operations.md))

## Getting Started: scaffold a new app

Don't hand-write `package.json`/`tsconfig.json`. Scaffold with the
`create-agentback` CLI — `npm create agentback` resolves to it:

```bash
npm create agentback my-service                       # hybrid (default)
npm create agentback my-service -- --template rest    # REST only
npm create agentback my-service -- --template mcp     # MCP only
```

The three templates are `hybrid` (default), `rest`, and `mcp`. **The `--`
matters with npm** — `npm create` passes everything before `--` to itself, so
`npm create agentback my-service --template rest` sends the flag to npm, not the
scaffolder. With `pnpm`/`yarn`/`bun` the `--` is unnecessary
(`pnpm create agentback my-service --template rest`). Short flag `-t` also works.

The app name must be a valid npm package name; a scoped name like
`@acme/my-service` creates the directory `my-service`. The CLI refuses to
overwrite a non-empty directory, and detects your package manager (from npm's
user-agent) to print the right next steps.

Each template lands a complete, runnable workspace — `application.ts` +
`main.ts`, a sample controller and/or tool class, a passing `vitest` test under
`src/__tests__/`, `tsconfig.json`, and `vitest.config.ts`. The
`@agentback/*` deps are pinned to a caret range. Then:

```bash
cd my-service
npm install          # or pnpm/yarn/bun
npm run build        # tsc — REQUIRED before test/start (tests run against dist/)
npm start            # run the app
npm test             # vitest
```

Programmatic use (e.g. from another tool) is available too — import `scaffold`
from `create-agentback` and pass `{name, template?, cwd?, version?}`.

## Quick Start: a hybrid REST + MCP app from shared schemas

```ts
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {mcpServer, tool, MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {isMain} from '@agentback/core';

// 1. One schema set — the single source of truth.
const AddIn = z.object({a: z.number().int(), b: z.number().int()});
const AddOut = z.object({sum: z.number().int()});
const HelloPath = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});

// 2. REST: Zod schemas live ON the verb decorator; slot 0 is the validated
//    input bundle ({path,query,body,headers} — only the keys you declared).
@api({basePath: '/greet'})
class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {path: z.infer<typeof HelloPath>}) {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/add', {body: AddIn, response: AddOut})
  async add(input: {body: z.infer<typeof AddIn>}) {
    return {sum: input.body.a + input.body.b};
  }
}

// 3. MCP: @tool puts input/output schemas on the decorator; slot 0 is z.infer.
@mcpServer()
class MathTools {
  @tool('add', {input: AddIn, output: AddOut})
  async add(input: z.infer<typeof AddIn>) {
    return {sum: input.a + input.b};
  }
}

async function main() {
  const app = new RestApplication({});
  app.restController(GreetingController); // discovered by the REST server (tag)
  app.component(MCPComponent);
  app.service(MathTools); // discovered by the MCP server (tag)
  await installMcpHttp(app); // POST/GET/DELETE /mcp on the same Express app
  await app.start();
  // REST  : GET /greet/hello/world, POST /greet/add, /openapi.json
  // MCP   : /mcp (Streamable HTTP) — same `add` tool, same schema
}

if (isMain(import.meta)) await main();
```

## Core Concepts Summary

| Concept             | Key APIs                                                                       | Notes                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| DI container        | `Context`, `BindingKey.create<T>()`, `@inject`, `@injectable`                  | Ported from `@loopback/core`; import from `@agentback/core`                                                                               |
| App + servers       | `RestApplication`, `MCPApplication`, `Application`, `Server`                   | `RestApplication` for HTTP (REST + MCP-over-HTTP); `MCPApplication` for a stdio MCP server. Servers discover bindings by tag at `start()` |
| Components          | `Component` with `components[]` / `services[]` / `bindings[]`                  | Composable packaging; `app.component(X)`                                                                                                  |
| REST routing        | `@api`, `@get/@post/@put/@patch/@del`, `{path,query,body,headers,response}`    | Zod on the decorator; slot 0 = validated input bundle                                                                                     |
| MCP tools           | `@mcpServer`, `@tool('name', {input, output, scope?})`, `@resource`, `@prompt` | Zod on the decorator; stdio + HTTP transport                                                                                              |
| OpenAPI             | emitted from Zod via `z.toJSONSchema({target:'draft-2020-12'})`                | `/openapi.json`, Swagger at `/explorer`                                                                                                   |
| Schema-typed client | `@agentback/client` (`defineRoute`, `routeGroup`, `safeCall`)                  | Browser-safe; shares the SAME Zod schemas; no codegen                                                                                     |
| Auth                | `@authenticate('jwt'\|'api-key'\|...)`, `@authorize({...})`, voters            | Strategies + voter pipeline; client-app scope governance                                                                                  |
| Rate limiting       | `installRateLimit(app)`, per-tool limits for MCP-over-HTTP                     | `rate-limiter-flexible`; in-memory or Redis                                                                                               |
| Operations          | `app.middleware()`, `installHealth`, `installMetrics`, CORS                    | Subclass `RestServer.dispatch`/`sendResult`/`sendError` for deep changes                                                                  |
| Agent runtime       | `@agentback/agent-*` + `agent-messaging`                                       | LLM agent stack on the DI substrate: engine + triggers, turn loop, tools, durable jobs                                                    |

## Key Rules

- **Import from `@agentback/core`** (it re-exports `context`, which
  re-exports `metadata`). Relative imports use **`.js`** extensions (ESM).
- **Tests run against built `dist/`** — `pnpm build` before `pnpm test`.
- **Zod schemas go on the decorator; never use `@param`/`@requestBody`/`@response`**
  (removed). Derive the handler input via `z.infer`.
- **REST slot 0 = the validated input bundle** when any schema is declared:
  `{body, path, query, headers}` (only declared keys). With no schema, slot 0 is
  unconstrained. `@inject` goes at slot 1+.
- **MCP slot 0 = `z.infer<typeof input>`** when `input` is declared; `@inject`
  at slot 1+. `@tool('ping')` with no input is valid.
- **`response:`/`output:` constrain the return type** and are validated at
  runtime (logged on mismatch for REST, thrown for MCP). `status:` overrides 200;
  204 sends an empty body.
- **URL placeholders must match the `path:` schema keys** (checked at
  `app.start()`). **Header schemas use lowercase keys.**
- **Discovery is by tag, not a router file.** `@api` tags a controller,
  `@mcpServer` tags a tool class; servers `findByTag` at start. "Add a feature"
  = "add a binding."
- **`@mcpServer()` is `@bind({tags:{mcpServer:true}})`** — `app.service()` /
  `app.controller()` read the class's bind metadata and tag automatically; never
  call `.tag()` manually for these.
- **`express` stays on `^4`** here; the schema-typed `client` depends on nothing
  but `zod` (browser-safe).
- Every source file carries the three-line MIT header
  (`// Copyright ninemind.ai and LoopBack contributors. …`).

## References

- **Dependency injection & components**:
  [references/dependency-injection.md](references/dependency-injection.md) —
  Context/Binding, `@inject`, providers, scopes, components, servers, lifecycle
  observers, tag-based discovery.
- **Zod-first REST**:
  [references/rest-and-openapi.md](references/rest-and-openapi.md) — `@api` +
  verb decorators, the input bundle, response/status, OpenAPI emission, Swagger,
  CORS/middleware, subclassing dispatch.
- **MCP tools**: [references/mcp-tools.md](references/mcp-tools.md) —
  `@mcpServer`/`@tool`/`@resource`/`@prompt`, dispatch, stdio vs HTTP transport,
  scope-gated tools, the inspector.
- **Schema sharing & client**:
  [references/schema-sharing-and-client.md](references/schema-sharing-and-client.md)
  — one schema for both ends, `defineRoute`/`routeGroup`/`safeCall`, no codegen.
- **Auth & rate limiting**:
  [references/auth-and-rate-limiting.md](references/auth-and-rate-limiting.md) —
  strategies (jwt/api-key/client-credentials/anonymous), `@authorize` voters +
  presets, client-application scope governance, REST + MCP-over-HTTP auth, rate
  limiting.
- **Composition & operations**:
  [references/composition-and-operations.md](references/composition-and-operations.md)
  — components, middleware/interceptors, health/metrics, lifecycle, packaging a
  new workspace package.
