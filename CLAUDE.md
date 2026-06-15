# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ESM/Zod/MCP fork of LoopBack 4 — a slim modern subset of `@loopback/core` + REST for building HTTP and MCP services out of the same DI container. ESM-only, Node 22.13+, TypeScript 6.0, pnpm 11 workspaces. Alpha (v0.2.0 published to npm — all `@agentback/*` packages + the `create-agentback` scaffolder); API still settling. Scaffold a new app with `npm create agentback my-service [--template rest|mcp|hybrid]`.

For the framework's design thesis (boundary coherence between Zod, OpenAPI, MCP, and DI — and why that matters for AI-led development), see [docs/agent-ergonomics.md](docs/agent-ergonomics.md). Read it before adding a feature that might introduce a second source of truth alongside the Zod schemas.

## Commands

```bash
pnpm install                       # install workspace deps
pnpm build                         # tsc -b across the whole workspace (project references)
pnpm build:watch                   # incremental watch build
pnpm clean                         # tsc -b --clean + rm -rf each package's dist
pnpm test                          # vitest run — IMPORTANT: requires a prior `pnpm build`
pnpm test:watch                    # vitest watch
pnpm typecheck:client              # tsc --noEmit on the esbuild client bundles (NOT covered by build/test)
pnpm verify                        # full local CI mirror: build + typecheck:client + test + validate-templates
pnpm lint                          # eslint + prettier --check
pnpm lint:fix                      # eslint --fix + prettier --write

pnpm -F <pkg> build                # build a single workspace package (e.g. `pnpm -F @agentback/rest build`)
pnpm -F hello-rest start           # run an example (after build)
pnpm -F hello-hybrid start         # REST + MCP from one process
```

Running a single test file or pattern:

```bash
pnpm build
pnpm exec vitest run packages/core/dist/__tests__/unit/application.unit.js
pnpm exec vitest run -t "name of test"
```

## Critical: tests run against built `dist/`, not `src/`

`vitest.config.ts` globs `packages/*/dist/__tests__/**/*.{test,spec,unit,integration,acceptance}.js`. After editing any `.ts` you must `pnpm build` (or have `build:watch` running) before `pnpm test` will pick up the change. The same rule applies to running examples — they `import` from each package's `dist/`.

## Architecture

### Workspace layout

`pnpm-workspace.yaml` includes `packages/*` and `examples/*`. Each package is `@agentback/<name>` and emits to its own `dist/`. The root `tsconfig.json` is a project-references file listing build order; per-package `tsconfig.json` extends `tsconfig.base.json` and declares its own `references`. Adding a new package means: create `packages/<name>/{src,tsconfig.json,package.json}`, add it to the root `tsconfig.json` references in dependency order, and `pnpm install` to wire the workspace symlinks.

### Two layers

1. **Ported faithfully from upstream LoopBack 4** (ESM-ified, `.js` extensions on relative imports, `lodash` → `lodash-es`, `p-event` v6 named exports):
   - `metadata`, `context` — decorator metadata + DI container
   - `core` — `Application`, `Component`, `Server`, lifecycle
   - `http-server`, `express` — HTTP server with graceful stop, Express integration
   - `authentication`, `authentication-jwt`, `authentication-oauth2`, `authorization`, `security` — auth stack (`-oauth2` adds RFC 7662 introspection + JWKS bearer tokens; bring-your-own auth server)
   - `extension-health`, `extension-metrics` — observability extensions
   - `testlab` — test helpers
2. **Rewritten, not ported** (upstream carried too much baggage):
   - `openapi` — Zod-first decorators. Emits OpenAPI 3.1.1 directly from Zod via `z.toJSONSchema({target: 'draft-2020-12'})` instead of the upstream `@loopback/repository-json-schema` pipeline.
   - `rest` — minimal `RestServer` (routing + Zod request/body validation + error mapping + serves `/openapi.json`). Replaces upstream's ~10k LoC of sequences/actions/middleware composition.
   - `mcp` — decorator-driven MCP server (`@mcpServer`, `@tool` with `input`/`output` Zod schemas) on top of the official `@modelcontextprotocol/sdk`. Runs stdio transport by default.
   - `mcp-inspector` — small in-process inspector UI at `/mcp-inspector`; the official `@modelcontextprotocol/inspector` is a CLI, not embeddable.
   - `rest-explorer` — mounts Swagger UI 5.x at `/explorer`.
   - `client` — schema-typed HTTP client. Both ends import the **same Zod schemas**; the client has no `@agentback/openapi` runtime dep (browser-safe). `defineRoute` + `routeGroup` + `safeCall` + typed `responses[status]`. No codegen. See `packages/client/README.md` and the `examples/hello-client` + `examples/hello-rest` pair for the schema-sharing pattern.

3. **New capability packages** (no upstream LB4 ancestor — added on top of the ported core). Each has a README; read it before touching the package:
   - `common` — shared infra utils (hosts `loggers`, the project's logging primitive — see Logging below).
   - `config` — Zod-validated, env-aware config loader (JSONC + YAML) with layered overlays and DI bindings.
   - `drizzle` — the blessed DB recipe: typed Drizzle client binding, lifecycle pool shutdown, `drizzle-zod` re-exports. One artifact chain (Postgres table → Zod → REST route + MCP tool); see `examples/hello-drizzle`.
   - `messaging` + `messaging-bullmq` — transport-agnostic messaging ports (`JobQueue`/`EventBus`/`QueueAdmin`/`Scheduler`) with typed Zod descriptors and an in-memory adapter; the BullMQ package is the durable Redis-backed adapter. See `examples/hello-jobs`.
   - `files` + `files-s3` — the file-storage `FileStore` port (`put`/`get`/`exists`/`delete` + optional presigned hooks) with in-memory and filesystem (`FsFileStore`) adapters; `files-s3` is the S3 adapter (AWS SDK v3 streaming). Backs the first-class upload/download recipe (`fileField` + `fileResponse`); `@agentback/files/testing` ships a shared conformance suite. See `examples/hello-uploads`.
   - `metering` — rail-neutral usage metering for REST + MCP calls (per-principal `UsageEvent`s, pluggable sink, per-principal quota).
   - `payments` — `PaymentRail` seam for REST/MCP calls; ships an x402 (HTTP 402) adapter (MPP/Stripe next). Authorizes payment; does not settle. See `examples/hello-x402`.
   - `plugin` — discover, gate, and mount Component-contributing plugins into an Application.
   - `extension-otel` — OpenTelemetry tracing across REST/MCP/jobs (`@opentelemetry/api` only; bring your own SDK/exporter).
   - `extension-rate-limit` — rate-limiting middleware (`rate-limiter-flexible`); in-memory or Redis, with 429 + `RateLimit` headers.
   - `mcp-http` — exposes the in-process MCP server over the MCP **Streamable HTTP** transport, mounted on the REST app's Express. Kept separate so `mcp` stays Express-free. **(This is the HTTP transport the old "not yet implemented" note referred to — it now exists.)**
   - `mcp-client` — thin wrapper over the SDK client for connecting to a remote Streamable-HTTP MCP server (incl. OAuth, with bearer injection + 401 refresh-retry).
   - `mcp-connect` — connect to remote MCP servers and proxy their tools/resources/prompts over a JSON API, incl. the full OAuth 2.1 handshake.
   - `mcp-host` — turn AgentBack into an MCP **gateway**: aggregate several upstream MCP servers (stdio/HTTP) into one surface and proxy calls; exposable over `mcp-http`.
   - `context-explorer` — read-only web UI for inspecting the DI container (every binding's key/scope/type/tags/source + parent chain); JSON API via a real `@api` REST controller.
   - `schema-explorer` — read-only web UI that indexes the app **by schema** instead of by protocol: every Zod entity as a node, with provenance edges to each REST route, MCP tool, and Drizzle table that uses it (joined by object identity; names + table origin come from `schema`-tagged context bindings via `bindSchema`/`@agentback/drizzle/zod`'s `register*Schema`). The inverse of the per-protocol explorers; JSON API via a real `@api` controller; an ERD-style field view. Reads both `rest` and `mcp`.
   - `console` + `console-theme` — unified dev console at `/console` composing context-explorer + schema-explorer + rest-explorer + mcp-inspector behind one shell; `console-theme` is the shared "newspaper" design tokens used by all five UIs.
   - `testing` — first-class test harness: `createTestApp` with binding overrides, typed in-process REST client, supertest bridge, in-memory MCP client.

### Schema-on-decorator routing (REST + MCP share this shape)

**REST verb decorators and `@tool` both put Zod schemas on the decorator and derive the handler's input type via `z.infer`.** No per-parameter `@param`/`@requestBody`/`@response`/`@arg` decorators — those were removed. The pattern:

```ts
const HelloPath = z.object({name: z.string().min(1).max(64)});

@get('/hello/{name}', {path: HelloPath, response: Greeting})
async hello(input: {path: z.infer<typeof HelloPath>}) { … }

@tool('forecast', {input: ForecastIn, output: ForecastOut})
async forecast(input: z.infer<typeof ForecastIn>) { … }
```

Rules to keep in mind when editing route/tool code:

- **Slot 0 = validated input bundle when any schema is declared.** For REST: `{body, path, query, headers}` (only the keys you declared). For MCP: `z.infer<typeof input>`. The decorator's `TypedPropertyDescriptor` enforces this at compile time — a wrong parameter type errors at the `@verb` / `@tool` line with the property mismatch surfaced precisely.
- **Slot 0 is unconstrained when no schemas are declared.** `@get('/whoami') async whoami(@inject(USER) user) {}` is valid; `@tool('ping') async ping() {}` is valid.
- **`@inject` lives at slot 1+** when schemas are declared. Putting `@inject` at slot 0 alongside a schema throws at decoration time with the class+method+verb in the message.
- **`response:` / `output:` constrain the return type.** When set, the method's return must satisfy `z.infer<typeof response>` (or `Promise<…>`) and is validated at runtime — logged on mismatch for REST, thrown for MCP.
- **`status:` on REST route options** overrides the default 200. Status 204 returns an empty body.
- **URL placeholders must match the `path:` schema's keys.** Checked at `app.start()`; mismatches throw with the controller+method named.
- **REST header schemas use lowercase keys.** Incoming headers are normalized before validation so `headers: z.object({'x-trace': z.string()})` finds the value regardless of how the client sent it.
- **MCP `@tool` `input:` must lower to an object root.** MCP `inputSchema` needs named properties at the root, so the schema must be a `z.object(...)` (a top-level `z.union`/`z.discriminatedUnion`/`z.intersection`/primitive is rejected at registration with the tool named). Express cross-field invariants with `.refine()` on the object — but note `.refine()` is validated at runtime only and is **not** reflected in the emitted `inputSchema` (`z.toJSONSchema` silently drops it), so document the rule in the field descriptions too.

Where the registrations live:

- Verb decorators store `RouteOptions` on `RestEndpoint` metadata + a per-route Zod bundle in `zod-bridge.ts`'s `routeRegistry`. `RestServer.makeHandler` reads the registry and weaves with `resolveInjectedArguments`.
- `@tool` stores `input`/`output` on `ToolMetadata`. `MCPServer.dispatchTool` parses input, resolves the tool **instance through its own binding** (`MCPServer.resolveMember`, so constructor `@inject` is honored), calls `resolveInjectedArguments` to weave method-level injects, applies the method, then validates output.

### `@mcpServer` and `@api` class tagging

`@mcpServer()` is `@injectable({scope: SINGLETON}, extensionFor(MCP_SERVERS))` under the hood — a tool class is a DI **service** that is an _extension_ of the `MCP_SERVERS` extension point, singleton by default (pass `@mcpServer({scope, tags})` or `@mcpServer('name')` to customize). **Register tool classes with `app.service(...)`** — a tool is a service. The MCP server discovers them via `ctx.find(extensionFilter(MCP_SERVERS))` and resolves each instance through its own binding (`resolveMember`), so constructor `@inject` works regardless of namespace (`service`, `controller`, or a manual `bind().apply(extensionFor(MCP_SERVERS))`). When you `app.service(SomeClass)`, `createServiceBinding` reads the class's bind metadata and tags the binding automatically — never call `.tag()` manually.

`@api()` REST controllers are discovered by the core `controller` tag (`CoreTags.CONTROLLER`) — `RestServer` does `ctx.findByTag(CoreTags.CONTROLLER)` and mounts the `@api`/`@verb` routes of each (a class with no route metadata is a no-op). `app.restController(C)` is a thin alias for `app.controller(C)` that exists for call-site readability; it adds no separate tag. A **dual REST + MCP class** (`@api` + `@mcpServer`) needs only **one** registration: `app.restController(C)` (or `app.controller(C)`) tags it `controller` (→ REST) and — because `restController` is *additive* and honors the class's `@mcpServer` metadata — keeps its `extensionFor(MCP_SERVERS)` membership (→ MCP). Do **not** also call `app.service(C)` for the same class: explicit `controller` + `service` calls deliberately produce **two** bindings, and with no collect-time dedup the MCP server would register the tool/resource twice. (Component registration is the exception — listing a class in both `controllers` and `services` arrays yields a single merged binding.)

### What's available vs deferred vs out of scope

**Out of scope** (the rewrite walked away from these deliberately — don't add them back):

- LB4 sequences/actions (`findRoute → parseParams → invoke → send → reject`). `RestServer.dispatch` is a single fixed pipeline; per-route customization lives on decorators, cross-cutting in middleware/interceptors, deeper changes via subclassing `RestServer` and overriding `dispatch` / `sendResult` / `sendError`.
- `@loopback/repository` and `Filter<T>` / `Where<T>` helpers.
- `x-ts-type` inlining (Zod schemas replace it).
- `@oas.deprecated` / `@oas.tags` / `@oas.visibility` decorator namespace.

**Available**, callers just need to know it exists:

- **Middleware chain** — `app.middleware(fn)` and `app.expressMiddleware(factory)` from `MiddlewareMixin(Application)`. The chain is mounted as the **first** Express handler in the `RestServer` **constructor** (matching upstream LB4's `ExpressServer`), so it fronts *every* route — including ones `install*` helpers (`installMcpHttp`'s `/mcp`, `installExplorer`, `installConsole`, …) mount before `app.start()`. `toExpressMiddleware` resolves and **group-sorts** the chain lazily per request, so middleware bound any time before the first request still participate. Order is governed by group tags + `upstreamGroups`/`downstreamGroups` topological sort (`MiddlewareView`), not registration order. The `MiddlewareContext`'s `request`/`response` are the standard Express objects. *(Don't mount middleware behind `start()`-mounted routes by adding `app.use` after construction — use `app.middleware` so it joins the chain.)*
- **CORS + body parsing are chain entries, not bare `app.use`** — `RestServer.registerBuiltinMiddleware` registers `cors` (group `RestMiddlewareGroups.CORS`) and the body parsers (group `parseBody`) **into** the chain, so the topological sort runs them `cors` → `parseBody` → your `middleware` group. **CORS**: `RestServerConfig.cors` — `true` for defaults, or `CorsOptions`. **Body parsing**: `RestServerConfig.bodyParser` — omit for JSON-only (the default), `false` to mount none (consume the raw stream / accept arbitrary media types yourself), or `{json?, urlencoded?, text?, raw?}` (each `true` or the matching Express parser's options) to accept media types beyond `application/json`. Position your own middleware relative to these with `app.middleware(fn, {upstreamGroups/downstreamGroups: [RestMiddlewareGroups.PARSE_BODY]})` — but a middleware in the default `middleware` group can't also point downstream at `parseBody` (parseBody already runs ahead of `middleware`; that's a cycle) — give it its own group.
- **`PORT`/`HOST` env** — `RestApplication`'s constructor resolves the server's port/host from three sources, highest precedence first: explicit `new RestApplication({rest: {port}})` config → `process.env.PORT`/`HOST` (12-factor deploys) → the defaults (`3000`/`127.0.0.1`). Env only fills a field the caller left unset, so explicit config is never clobbered; a malformed `PORT` warns and falls back, `PORT=0` is honored (ephemeral).
- **Subclassable dispatch** — `RestServer.makeHandler` / `dispatch` / `sendResult` / `sendError` are all `protected`. Subclass for envelope wrappers, custom error shapes, request-scoped tracing, etc.; bind the subclass via `app.server(MyRestServer)`.
- **`AgentError` for client-correctable domain errors** — `@agentback/openapi` exports `AgentError`, a transport-neutral error carrying `status`/`code`/`message` (plus optional `issues`/`hint`/`schema`/`retryable`) that `buildErrorEnvelope` reads. A plain `Error` thrown from a service or `@tool` is redacted to a generic 500 (`internal_error`, "Internal Server Error") on both surfaces — its message never reaches the caller; `throw new AgentError('Provide a city or coordinates.', {code: ErrorCodes.INVALID_INPUT})` (defaults to 400) preserves it. REST-specific `invalidParameter`/`invalidRequestBody` still exist; use `AgentError` in cross-transport domain code.
- **Injectable `fetch` seam** — `CoreBindings.FETCH` (typed `Fetch = typeof globalThis.fetch`, exported from `@agentback/common`) is the DIP boundary for outbound HTTP. A domain service that calls an external API should inject it instead of reaching for the global, so tests bind a stub with no network: `constructor(@inject(CoreBindings.FETCH, {optional: true}) private fetch: Fetch = globalThis.fetch) {}`. Override in tests via `createTestApp(App, {overrides: {[CoreBindings.FETCH.key]: stub}})`.
- **`createTestApp` is the testing default** — `@agentback/testing`'s `createTestApp(AppOrFactory, {overrides, config, mcpScopes})` boots the app on an ephemeral port and returns `{app, url, client (typed), http (supertest), mcp (in-memory MCP client), call(), stop()}` and is `await using`-disposable. Prefer it over hand-rolling `getServer('MCPServer')` / `buildHttpApp({port:0})` in app tests — see `packages/testing/README.md`.
- **`new RestApplication({rest: {...}})` configures the RestServer** — the constructor's `rest` key is forwarded to the `servers.RestServer` config binding, so `{rest: {port, host, basePath, cors}}` works directly. A later `app.configure(RestBindings.SERVER).to(...)` still overrides it (last write wins).

### Logging

**`loggers` from `@agentback/common` is the single logging primitive — use it everywhere.** Do not import the `debug` npm package directly in any package (the one exception is `common/src/utils/debug{,-factory,-pino}.ts`, which _implement_ `loggers` on top of `debug` and pino).

`loggers(namespace)` returns a `{error, warn, info, debug, trace}` record — each entry is a `Debugger` (callable, has `.enabled`), backed by a sub-namespace (`ns:error`, `ns:debug`, …). On top of raw `debug` it adds: level routing, secret redaction (`redactData`/`maskSecret`), an `onLog(hook)` sink for shipping warn/error events to external systems, optional pino structured-JSON output, and `DEBUG_DEPTH` inspect control. The usage shape:

```ts
import {loggers} from '@agentback/common';
const log = loggers('loopback:context:binding');
if (log.debug.enabled) log.debug('Get value for binding %s', this.key);
```

**Namespace note:** because each level is a sub-namespace, a `loggers('foo:bar')` line logs under `foo:bar:debug` (etc.), not `foo:bar`. Set `DEBUG=foo:bar:*` (or `foo:bar:debug`) to see it. The ported LB4 packages were migrated off raw `debug` to `loggers` in one pass; everything maps to `log.debug` (raw `debug` ≈ debug level) unless a call is semantically a warn/error.

**File uploads / downloads are first-class** (no longer an escape hatch). A `fileField()` (from `@agentback/openapi`) on a route's `body:` schema flips the request to `multipart/form-data` (emitted in OpenAPI as `format: binary`), auto-mounts a per-route multer parser that **streams** each file to the bound `FileStore` (`@agentback/files`) under a **server-generated UUID** key, and delivers `UploadedFile` handles in the validated slot-0 bundle. Downloads `return fileResponse(...)` / `fileDownload(retrieved)`, which `RestServer.sendResult` pipes (Content-Type/Disposition) instead of JSON-encoding. Storage is a port: `InMemoryFileStore` (dev/tests) or `S3FileStore` (`@agentback/files-s3`). `RestBindings.HTTP_REQUEST`/`.HTTP_RESPONSE` are bound per request for raw-stream escape hatches. See `examples/hello-uploads`. (`multer` is currently a direct `rest` dependency — a candidate to optionalize as a peer dep.)

MCP HTTP transport **is** implemented — `@agentback/mcp` runs stdio by default, and `@agentback/mcp-http` adds the Streamable HTTP transport mounted on the REST app's Express (per-session isolation). See the New capability packages list above.

## Deps and versioning

Default policy: **bump everything to the latest** with `ncu -ws --root -u` (monorepo-aware), then `pnpm install` from a clean `pnpm-lock.yaml` and verify `pnpm build && pnpm test` pass.

Exceptions to "latest", and why:

- **`@types/node`** — pinned to the latest **even** major (Node LTS line). `ncu` will pick odd majors like 25; reset to `^24.x` (or the next even after 24) by hand after running it.
- **`express` stays on `^4`** — express 5 changes `req.params` to `string | string[]` and reshapes async error semantics; `mcp-inspector` and `rest` both depend on the v4 typing. Migrate as a focused PR, not as a dep bump.
- **`p-event` stays on `^6`** — v7 reshaped the `iterator()` return type; `context-subscription.ts` was ported assuming the v6 named exports. Same — focused migration, not a drive-by.

When `ncu` produces a result that won't build, prefer pinning back the offender (with a one-line reason in the commit message) over patching code, unless the upgrade was the goal.

### pnpm 11 quirks worth knowing

- **Supply-chain age policy**: pnpm 11 rejects lockfile entries published within a recent window (currently ~24h). If install fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, pin the offending dep one patch/minor older.
- **`pnpm-workspace.yaml` `allowBuilds`**: pnpm 11 requires per-package opt-in for postinstall scripts. The first install on a fresh machine writes `allowBuilds: { '<pkg>': set this to true or false }` placeholders into `pnpm-workspace.yaml`; replace `set this to ...` with `true` or `false` and rerun. Don't commit placeholders.
- **`verify-deps-before-run=false`** is set in `.npmrc` — pnpm 11 otherwise re-runs `pnpm install` before each `pnpm <script>`, which fails on the supply-chain check inside scripts that don't need re-resolution.

## Releasing

Versioning is **lockstep**: every `@agentback/*` package + `create-agentback` shares one version and releases together. Internal deps use `workspace:~`, which pnpm rewrites to `~<version>` at publish time (so patches propagate to consumers; verify with `pnpm -F <pkg> pack` + inspect the packed `package.json`). To cut `X.Y.Z`:

1. **Bump** every `packages/*/package.json` `version` to `X.Y.Z` (lockstep — do not bump one package alone; `create-agentback`'s scaffolded version range is derived from its own version).
2. **Verify**: `pnpm install && pnpm build && pnpm test` all green.
3. **Commit** (`chore(release): lockstep X.Y.Z`) and push.
4. **Publish** (OTP-gated, so run interactively): `pnpm -r publish --access public --no-git-checks`. Publishes in dependency order and **skips versions already on the registry**, so re-running after an OTP timeout is safe.
5. **Tag + push** — npm publish touches nothing in git, so tag the release commit and push it (otherwise the registry and repo history drift apart):
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   gh release create vX.Y.Z --latest --title vX.Y.Z --notes "…"   # optional, matches v0.1.0+
   ```
6. **Bump dependent repos** (e.g. the demo) to `^X.Y.Z` and re-verify against the published packages.

Right after a publish, a consumer `npm install` can briefly 404 the new version (registry/CDN propagation lag) even though `npm view <pkg> version` shows it — retry with `--prefer-online` before assuming a partial release.

## Style

`.prettierrc.json`: single quotes, no bracket spacing (`{foo}` not `{ foo }`), trailing commas everywhere, 80 col, arrow parens avoided when possible. ESLint flat config warns on `any` and unused vars (ignore via `_` prefix).

## Licensing and copyright headers

The project is MIT-licensed (root `LICENSE`, `Copyright (c) ninemind.ai`). Every source file carries a three-line header — keep it on new files:

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/<pkg>
// This file is licensed under the MIT License.
```

**Do not reintroduce `Copyright IBM Corp.` headers.** This is a LoopBack 4 fork; much of `metadata`/`context`/`core`/`http-server`/`express`/the auth stack/`extension-*`/`testlab` is ported from upstream. MIT requires retaining the upstream copyright + permission notice, but **not per-file** — that attribution lives once in root `THIRD-PARTY-NOTICES.md`. If you port more code from another MIT/BSD/Apache project, add its notice there; don't paste its per-file headers in.

## CI

`.github/workflows/ci.yml` runs, on Node 22.13 and 24 (pnpm 11 requires Node ≥ 22.13): `pnpm install --frozen-lockfile` → `pnpm build` → **`pnpm typecheck:client`** → `pnpm test`, plus a separate **validate-templates** job (`pnpm build` → `node scripts/validate-templates.mjs`). The lockfile must be committed in sync with `package.json` changes or CI fails at install.

**Run `pnpm verify` before pushing — it mirrors CI** (build + typecheck:client + test + validate-templates). `pnpm build`/`pnpm test` alone are **not** sufficient: esbuild bundles the client `.tsx` without type-checking and vitest runs only the server `dist/`, so neither catches client-bundle type errors. The CI-only `typecheck:client` step (`tsc -p tsconfig.client.json --noEmit` per UI package) is the one that does — e.g. a client file importing from `src/lib`/`src/model.ts` must be inside that package's `tsconfig.client.json` `include`.
