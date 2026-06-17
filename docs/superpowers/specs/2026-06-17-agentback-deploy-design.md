# `agentback deploy` — Design

**Date:** 2026-06-17
**Status:** Approved design, pre-implementation
**Topic:** A first-party CLI command to deploy an AgentBack app to edge runtimes (v1: Cloudflare Workers, Vercel, Deno Deploy), architected so AWS can graduate to first-party provisioning later.

---

## 1. Goal & framing

Give AgentBack users a one-command path from a local app to a running edge deployment:

```bash
agentback deploy cloudflare
abc deploy vercel --prod
```

AgentBack already has the *runtime* precondition for this: `RestServer.fetchHandler()`
is a runtime-neutral `fetch(Request): Promise<Response>` (see
`packages/rest/src/host/fetch.ts`), and `examples/hello-hosts` proves one app runs
unchanged on Fastify, Hono, Bun, and the native listener. What is missing is the
*tooling* to bundle that handler, generate a per-target entrypoint, push it via the
platform's deploy mechanism, and verify the result. This spec defines that tooling.

**Non-goal:** building our own infrastructure layer in v1. We orchestrate the
platforms' own CLIs and leave a seam for first-party provisioning later.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Deploy model | **Hybrid — orchestrate now, own later** | Thin orchestrator over platform CLIs ships fast; `DeployTarget` interface lets AWS graduate to first-party provisioning without touching the pipeline. |
| v1 targets | **Vercel (reference, first), then Cloudflare Workers, Deno Deploy** | **Vercel is the reference adapter** because `agentback-demo` is already deployed there in production (§2.5) — the Vercel-Node path is proven, so it ships first; Workers/Deno follow with the harder edge-isolate work. AWS deferred (needs infra provisioning, not just a CLI handoff). |
| Config surface | **Zero-config + flags now**; patch native platform files; reserve `agentback.config.ts` `deploy` block for later | Smallest first release; power users keep the platform knobs they already know. |
| Edge entrypoint | **Generated ephemerally, `--eject` to commit** | Repo stays clean and entry always matches the CLI version; ejection is the escape hatch for customization. |
| MCP on edge | **Bridge already exists**; deploy carries a per-target MCP smoke test as the acceptance gate | `mountMcpHttpFetch` (`WebStandardStreamableHTTPServerTransport`) already serves MCP on the fetch surface with auth parity + passing tests. Residual risk is runtime, not code — the smoke test catches it. |
| CLI scope | **Deploy-only `@agentback/cli`** | One verb, smallest surface. `dev`/`build`/`generate` are later specs. |
| Static assets on edge | **Formalize `AssetSource` (D) + CDN dev UIs (C) + opt-in `--bundle-assets` (B)**; defer platform-native (A) | `serveStaticDir`'s disk read is the only true edge incompatibility, and it is opt-in. Fix it at the seam so dev UIs work on edge out-of-the-box. |

## 2.5. Prior art: `agentback-demo` on Vercel (the reference)

`agentback-demo` (`weather-mcp`) is already deployed to Vercel and is the concrete
pattern the Vercel adapter codifies. Three things it establishes:

- **Memoized async boot is production-proven.** `api/index.ts` does
  `appPromise ??= buildExpressApp()` and exports a Node `handler(req, res)` that calls
  `server.expressApp` — the §5 bridge, with the **Express app** as the leaf (Vercel Node
  runtime). Cold start builds; warm invocations reuse the promise.
- **`vercel.json` is the config template.** `buildCommand`, `outputDirectory: public`,
  `rewrites` all paths to `/api`, and `functions["api/index.ts"].includeFiles` to ship
  `@agentback/console/dist/client` + `swagger-ui-dist` into the function bundle.
- **It deliberately omits live MCP.** The entry comment: *"This console entry does not
  mount the Streamable HTTP MCP transport, so there is no `/mcp` route here."* So
  `deploy` wiring MCP into the generated entry — and proving it with the smoke test
  (§6) — delivers a live `/mcp` on Vercel for the first time, not a redundant check.

**Consequences for v1 scope:**

- On **Vercel Node**, `serveStaticDir` works unmodified (real filesystem +
  `includeFiles`). The `AssetSource`/CDN/embed work (§8) is a **Workers/Deno** concern
  and lands with those adapters, not in the Vercel-first slice.
- On **Vercel Node**, MCP can mount via the **Express transport** (`mountMcpHttp`, the
  original req/res path) — no fetch transport required. The fetch transport
  (`mountMcpHttpFetch`) is needed only for Edge/Workers/Deno.
- The **bundle doctor** (§7) is likewise an edge-runtime guard; Vercel Node has Node
  built-ins and a filesystem, so it lands with the edge adapters.

## 3. CLI shape

New workspace package **`@agentback/cli`** at `packages/cli/`.

```jsonc
// packages/cli/package.json (excerpt)
"bin": { "agentback": "dist/cli.js", "abc": "dist/cli.js" }
```

- `agentback` is the canonical, self-documenting name; `abc` is the terse alias.
  **`ab` is intentionally NOT claimed** — it shadows ApacheBench, a widely
  installed benchmarking tool.
- Dependency: `@clack/prompts` (consistent with `create-agentback`).
- A small hand-rolled argument parser — one verb does not justify a command framework.

```
agentback deploy <target> [options]

  target              cloudflare | vercel | deno

  --name <n>          service name (default: package.json "name")
  --env KEY=VAL       env/secret, repeatable; forwarded to the platform's own store
  --env-file <path>   bulk env from a dotenv file
  --prod              production deploy (default: preview/staging)
  --edge              Vercel only: Edge runtime instead of the default Node runtime
  --eject             write entry + config into the repo, then STOP (print next steps)
  --bundle-assets     embed disk-served static assets into the bundle (see §8)
  --dry-run           generate + preflight only, never shell out (CI-safe)
  --skip-mcp-check    bypass the MCP acceptance gate
  --yes               non-interactive (assume defaults, no prompts)
```

## 4. The deploy pipeline (6 stages)

```
detect → resolve adapter → generate → preflight → deploy → verify
```

1. **Detect.** Locate the app entry (convention: `src/application.ts` exporting the
   `Application` class; overridable later via config). Introspect which `install*`
   calls are present to classify the app as **REST-only**, **hybrid**, or
   **MCP-bearing**, and to spot edge-hostile installs (disk-served UIs). This drives
   the entry template and whether the MCP gate runs.
2. **Resolve adapter.** Select the `DeployTarget` implementation for `<target>`.
3. **Generate.** Write the ephemeral edge entry and patch the native platform config
   into `.agentback/deploy/<target>/` (gitignored). `--eject` writes into the repo
   instead and stops with printed next steps.
4. **Preflight.** Verify the platform CLI is installed and authenticated
   (`wrangler whoami`, `vercel whoami`, `deployctl --version`). Never auto-install;
   print the exact install/login command on a miss. Run the **bundle doctor** (§7).
5. **Deploy.** Shell out to the platform CLI, streaming its output. (`--dry-run` stops
   before this stage.)
6. **Verify (acceptance gate).** Resolve the live URL; GET `/openapi.json` for REST
   liveness; if the app bears MCP, run the **MCP smoke** (§6). Report
   `PASS` / `degraded` / `FAIL` with the underlying error.

## 5. The async-boot → edge-fetch bridge (the crux)

AgentBack apps boot **asynchronously** (`await buildApp()` runs DI, route collection,
OpenAPI emission); `host.fetch` exists only after that await. Edge runtimes want a
module that **synchronously** exports `default { fetch }`. The generated entry bridges
the gap by memoizing the boot so the app builds **once per isolate cold start**:

```ts
// .agentback/deploy/cloudflare/entry.ts  (generated; shape adapts per target)
import {buildApp} from '<detected-app>';

let booted;
const host = () => (booted ??= buildApp());

export default {
  fetch: async (req, env, ctx) => (await host()).fetch(req),
};
```

The memoized-boot pattern is identical across targets; only the **leaf** differs by
runtime:

- **Vercel Node (v1 default, proven by `agentback-demo`):** the leaf is the **Express
  app** — `handler(req, res)` calls `server.expressApp` (a Node `RequestListener`). No
  fetch bridge needed; the Node listener is *wanted* here.
- **Cloudflare / Deno / Vercel Edge:** the leaf is the **fetch handler** —
  `export default { fetch }` (Workers / Vercel Edge) or
  `Deno.serve((req) => host().then(h => h.fetch(req)))`.

**Critical for edge leaves only:** the entry imports the **fetch path**, never
`app.start()` — that is what lets esbuild tree-shake the Node `http` listener
(`createNodeListener`) out of the bundle (see §7). The Vercel-Node leaf does not need
this (it deliberately uses Express).

## 6. MCP on edge — already bridged, gated by smoke test

`packages/mcp-http/src/fetch.ts` exports `mountMcpHttpFetch()`, built on the MCP SDK's
`WebStandardStreamableHTTPServerTransport` (`handleRequest(Request): Promise<Response>`).
It has full auth parity (OAuth resource-server bearer + strategy auth), per-session DI
contexts, and a passing integration suite (initialize handshake, `tools/list`, tool
call, resource read, session pinning). `installMcpHttp` auto-routes to it in `native`
mode.

So MCP-over-HTTP is **code-complete on the fetch surface**. Two paths to a live `/mcp`:

- **Vercel Node (v1):** mount via the **Express transport** (`mountMcpHttp`, the original
  req/res path) — already battle-tested, and Vercel Node has req/res. The Vercel adapter
  wires this into the generated entry, which `agentback-demo` deliberately omits today —
  so `deploy` produces the **first live `/mcp` on Vercel**.
- **Cloudflare / Deno / Vercel Edge:** mount via the **fetch transport**
  (`mountMcpHttpFetch`). Here the residual risk is **runtime** — the tests run under
  Node's `native` listener, not a real isolate.

Either way, the deploy command closes the gap with an **acceptance gate**: against the
live deployed URL, run `initialize` → `tools/list` → one tool call. If any step fails,
the target is reported **degraded** (REST live, MCP failing) with the runtime error,
surfacing problems at deploy time rather than first agent call. The smoke client reuses
the JSON-RPC shape from the existing `fetch.integration.ts` tests (or
`@agentback/mcp-client` if it can target a remote URL).

## 7. `DeployTarget` interface & the bundle doctor

### Interface — the "own later" seam

```ts
interface DeployTarget {
  id: 'cloudflare' | 'vercel' | 'deno';
  generateEntry(app: DetectedApp): string;        // §5 bridge, per target
  generateConfig(app: DetectedApp, opts): FileEdit[]; // wrangler.toml / vercel.json / deno cfg
  preflight(): Promise<Diagnostic[]>;             // CLI installed + authed, bundle doctor
  deploy(opts): Promise<{url: string}>;           // v1: shells the platform CLI
  smokeUrls(url: string): {rest: string; mcp?: string};
}
```

v1 ships three implementations that **shell out**. AWS later implements the *same*
interface, but its `deploy()` does first-party provisioning (CDK/SST/Pulumi) instead of
shelling a CLI — graduating "orchestrate → own" without changing the pipeline.

### Bundle doctor — a concrete allow/deny list, not a vague grep

Investigation of the request-path bundle (`@agentback/core`, `context`, `metadata`,
`rest`, `mcp`, `mcp-http`) established:

- **`reflect-metadata` / decorator DI works on Workers.** It is a pure-JS polyfill that
  patches global `Reflect`; no Node APIs. The DI engine runs in an isolate. *This is not
  a blocker.*
- `node:http`/`node:net`/`ServerResponse`/`IncomingMessage` are **type-only** (erased)
  or live in the **Node-listener path** (`createNodeListener`), tree-shaken out when the
  entry exports `fetch`.
- `node:crypto` (`randomUUID`), `node:stream` (`Readable`), `node:url` are covered by
  Cloudflare's `nodejs_compat` flag (and `randomUUID` is also a Web global).
- The **only true incompatibility** is `node:fs/promises` + `node:path` in
  `host/static.ts` (`serveStaticDir`) — disk reads, no filesystem on Workers. It is
  **opt-in**: only pulled in by disk-served assets (e.g. swagger-ui in the explorer).

The bundle doctor therefore enforces a finite list and the generated `wrangler.toml`
ships `compatibility_flags = ["nodejs_compat"]` + a recent `compatibility_date`:

| Module | Verdict |
|---|---|
| `node:crypto`, `node:stream`, `node:url`, `node:buffer` | **Allow** (nodejs_compat-backed) |
| `node:fs`, `node:fs/promises`, `node:path` (disk), `node:net` | **Hard-fail** — name the offending module *and* the likely culprit (`serveStaticDir` / explorer) |

The **detect** step additionally warns when it sees `installExplorer`/`installInspector`
targeting an edge deploy without the asset fix from §8.

## 8. Static assets on edge — `AssetSource`

`serveStaticDir(dir)` already returns `(suffix: string) => Promise<Response | undefined>`
— an interface whose disk dependency is an implementation detail of one factory, not part
of the contract. We formalize it and add edge-friendly factories. **Disk stays the
default on Node; nothing breaks.**

```ts
type AssetSource = (suffix: string) => Promise<Response | undefined>;

fromDisk(dir): AssetSource          // (D) current behavior, default on Node
fromCdn(baseUrl): AssetSource       // (C) proxy/redirect to a public CDN
fromEmbeddedMap(map): AssetSource   // (B) in-memory bytes, populated at build time
// fromPlatformAssets(binding)      // (A) deferred — CF assets binding, Vercel static, etc.
```

In scope for this spec:

- **(D) Formalize `AssetSource`** in `@agentback/rest`. `install*` UI helpers gain an
  optional `assets?: AssetSource`; default remains `fromDisk`.
- **(C) CDN-reference the dev UIs.** The explorer/inspector HTML is already an inline
  string (`new Response(html)`); point its `<script>`/`<link>` at
  `cdn.jsdelivr.net/npm/swagger-ui-dist@5/…`. Result: explorer + inspector need **no
  static dir** and work on every target out-of-the-box. (Served swagger subset is
  ~1.5 MB raw / ~400–500 KB gzipped — worth *not* bundling.)
- **(B) `--bundle-assets`.** An esbuild plugin reads a user's `serveStaticDir` directory
  and inlines it as an `fromEmbeddedMap` source for users with custom static dirs.
  Off by default; mind Workers' script-size limits (1 MB free / up to 10 MB paid, gzipped).

Deferred: **(A) platform-native asset bindings** — the "own later" tier, alongside AWS.

## 9. Secrets & env

Env/secrets are **forwarded, never stored.** `--env KEY=VAL` / `--env-file` map to the
platform's own mechanism (`wrangler secret put`, `vercel env`, `deployctl --env`). The
CLI holds no secret state.

## 10. Testing strategy

- **Unit / snapshot:** per adapter, snapshot the generated entry and the patched config
  files. Pure functions, no network.
- **`--dry-run` in CI:** runs detect → generate → preflight → bundle doctor and stops
  before any shell-out. Default CI path; no credentials required.
- **MCP smoke client:** unit-tested against a local `native` server (reuse
  `fetch.integration.ts` JSON-RPC shape).
- **Real edge e2e:** opt-in, credential-gated, NOT in default CI — one deploy per target
  asserting REST liveness + MCP smoke against the live URL.

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Decorator/DI metadata on edge | **Resolved — not a blocker** | `reflect-metadata` is portable JS; verified in §7. |
| Node built-ins in the edge bundle | Medium | Bundle doctor allow/deny list + `nodejs_compat`; entry imports fetch path so the Node listener tree-shakes out. |
| Disk-served static assets (`serveStaticDir`) | Medium | `AssetSource` seam (§8): CDN dev UIs, opt-in embed; doctor hard-fails the rest with a named culprit. |
| MCP transport breaks in a real isolate | Medium | Acceptance-gate smoke test reports `degraded` at deploy time, not at first agent call. |
| Vercel dual runtime (Edge vs Node) | Low | Default to Node functions (full API); `--edge` opts in. |

## 12. Out of scope (this spec)

- **AWS** (Lambda + Function URL / API Gateway) — needs infra provisioning; first
  consumer of the `DeployTarget` "own later" path.
- **`agentback.config.ts` `deploy` block** — multi-target / multi-env config, added when
  the need is real.
- **Other CLI verbs** (`dev`, `build`, `generate`).
- **Platform-native asset bindings** (`AssetSource` option A).
- **Domain / DNS configuration.**

## 13. Build sequence (for the implementation plan)

**Phase 1 — Vercel (reference, rides proven `agentback-demo` patterns):**

1. `@agentback/cli` package skeleton: bins (`agentback`/`abc`), arg parser, `deploy`
   command shell, `--dry-run`.
2. `DetectedApp` detection + app classification (REST / hybrid / MCP).
3. `DeployTarget` interface + **Vercel-Node adapter**: generate `api/index.ts`
   (memoized Express-app leaf), generate `vercel.json` (rewrites + `includeFiles`), wire
   `mountMcpHttp` for a live `/mcp`, preflight (`vercel whoami`), shell `vercel deploy`.
4. MCP smoke client + acceptance gate (first live-`/mcp`-on-Vercel proof).
5. `--eject`, `--env`/secrets forwarding (`vercel env`), docs.

**Phase 2 — edge runtimes (the harder, isolate-specific work):**

6. Fetch-handler entry leaf (§5) + bundle doctor (§7) + `compatibility_flags`.
7. `AssetSource` (D) + CDN dev UIs (C) in `@agentback/rest` + explorer/inspector.
8. **Cloudflare Workers** adapter, then **Deno Deploy** adapter (+ optional Vercel `--edge`).
9. `--bundle-assets` esbuild embed (B).
10. Refresh `docs/guides/deploy-to-edge.md`; correct the stale `hello-hosts` MCP caveat.
