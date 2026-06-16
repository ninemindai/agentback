# Fetch-API Adapter Seam — Design

- **Date:** 2026-06-16
- **Status:** Stage 1 **shipped** — Part 1 (plumbing), Part 2 (`RestHandler` core dispatch), Part 3 (additive Fetch surface: registry→`Router` via `collectRoutes`, `RestServer.fetchHandler()`, `createTestApp.fetch()`, exported seam). The Fetch surface is registry-wired and parity-proven against Express. **Remaining (not the additive surface):** full Express demotion (route everything through the core); porting auth/authz, dispatch hooks, confirmation/idempotency, and streaming/SSE to the Web pipeline (Express-only today); file uploads (Stage 3); `FastifyHostAdapter`; neutralizing the `install*` dev UIs for non-Express hosts.
- **Scope:** Prove a runtime-neutral dispatch seam for `@agentback/rest` with a Web `Request`→`Response` core, full feature parity, exercised by tests. **No production deployment** to edge runtimes in this work.

## Motivation

AgentBack's `RestServer` is coupled to Express 4/5 and Node's `http` server: route matching, the middleware chain, request reading, and response writing all assume Express objects. This blocks running the same routing + Zod-validation + DI pipeline on Web-standard runtimes (Cloudflare Workers, Deno, Bun, edge).

The lesson drawn from Hono: invert the design so the **framework owns a Web-standard core** (`fetch(Request): Promise<Response>`) and each runtime/host is a thin leaf adapter. The Express 5 migration (2026-06-16) removed the version pin that previously blocked this, and `mcp-client` was already made browser-safe — the appetite and the runway both exist.

This is the highest-leverage of the Hono lessons surveyed (others: RegExpRouter, Standard Schema, `hono/jsx` for UIs, middleware simplification). RegExpRouter becomes a natural later drop-in once the core owns routing.

## Goals

- A runtime-neutral `RestHandler.fetch(req: Request): Promise<Response>` that is the single dispatch path.
- Express remains the **default Node host** with its public API unchanged (`start`/`stop`/`url`/`expressApp`); no existing app or example changes.
- A `FetchHostAdapter` that returns the bare fetch handler, proven by in-process tests asserting real `Response` objects.
- **Full feature parity** through the neutral path: JSON routes, validation, DI, error envelope, confirmation/idempotency, middleware, multipart uploads, streaming/file downloads.

## Non-Goals

- Deploying to Workers/Deno/Bun (the Fetch handler tests *are* the proof; real deploy is a follow-up).
- A `FastifyHostAdapter` (additive follow-up — trivial because of the seam).
- Neutralizing the `install*` dev UIs (explorer / mcp-http / rest-explorer / console) — they stay Express-host-only for now (see Known Limitations).
- RegExpRouter (later optimization once the core router exists).

## Approach (chosen: A — Web Request/Response as internal currency)

The core stops delegating routing to Express and **becomes a self-contained fetch handler** using the Web globals (`Request`/`Response`/`Headers`/`FormData`/`ReadableStream`, all standard in Node 22 via undici).

```
                    ┌─────────────────────────────────────────────┐
                    │  @agentback/rest core  (runtime-neutral)     │
   Web Request ───▶ │  RestHandler.fetch(req: Request): Response   │
                    │   1. middleware onion (pre)                  │
                    │   2. router match  (method + path → route)   │  no match →
                    │   3. build+validate {body,path,query,headers}│  signal; host
                    │   4. resolve controller via DI · invokeRoute │  calls next()
                    │   5. validate output → build Response        │
                    │   6. middleware onion (post)                 │
                    └─────────────────────────────────────────────┘
                          ▲                              ▲
          ┌───────────────┴────────┐         ┌───────────┴───────────────┐
          │ NodeHostAdapter (deflt)│         │ FetchHostAdapter           │
          │ Express/http →Web→ core│         │ returns the bare fetch fn  │
          │ hosts explorer/mcp-http│         │ (Workers/Deno/Bun/tests)   │
          └────────────────────────┘         └────────────────────────────┘
```

**Key inversion:** Express had owned route matching (`this.app[verb](toExpressPath(path), handler)`). Under A, the **core owns routing** (match method + `{name}` template against the route registry, extract params); Express is demoted to a host that runs the onion, hosts the Express-mounted UIs, and hands `@api` routes to the core via a single **non-greedy** converting handler.

### Alternatives rejected

- **B — bespoke `RestRequest`/`RestResponse` ports.** Lowest behavior risk (keeps multer/Express exactly), but reinvents a mini Web-standard abstraction and portability isn't free (each runtime needs a hand-written port). Gives up the "runtimes for free" payoff.
- **C — Web currency + adapter-owned multipart/stream escape hatches.** Avoids Node-path perf regression but is the most complex, maintains two multipart paths, and risks leaking transport concerns back into the "neutral" core.

## Components

### File layout in `@agentback/rest`

| File | Role | Origin |
|---|---|---|
| `web/router.ts` | Core router: compile route registry → `(method, pathname) → {route, params}`; **non-greedy** (no match → caller `next()`s). Houses the path-key-vs-schema check moved out of `start()`. | new |
| `web/rest-handler.ts` | The neutral `RestHandler.fetch(req): Promise<Response>`. Absorbs today's `dispatch` / `invokeRoute` / `sendResult` / `sendError`, retargeted to Web objects. | refactor of `rest.server.ts` |
| `web/middleware.ts` | Onion runner; orders neutral middleware via the group sorter. | new |
| `web/multipart.ts` | Web `request.formData()` → stream each `File` to `FileStore` under a UUID → `UploadedFile` handles. Replaces multer on the core path. | rewrite of `multipart.ts` |
| `web/convert.ts` | Node `IncomingMessage`/`ServerResponse` ↔ Web `Request`/`Response`. | new |
| `host/node.ts` | `NodeHostAdapter`: Express app, onion as outermost layer, `install*` UI mounts, core handler as fallback, `http.createServer`/listen, the `expressApp` getter. | extracted from `rest.server.ts` |
| `host/fetch.ts` | `FetchHostAdapter`: returns `{fetch}` for Workers/Deno/Bun/tests. | new |
| `rest.server.ts` | Slims to *be* the NodeHostAdapter; public API unchanged. | slimmed |

**Targeted refactor (in scope):** relocate the pure group-topology sorter from `@agentback/express` (`group-sorter.ts`) to `@agentback/common` so the neutral onion can use it without `rest` depending on the `express` package (a wrong-direction dep).

### Middleware — two explicit tiers

- **`app.middleware(fn)` — neutral onion middleware.** `(req: Request, ctx, next) => Promise<Response>`. Runs on **every host**. CORS becomes one of these. Body-parsing largely disappears — Web `Request` exposes lazy `.json()`/`.formData()`/`.text()`, so "parse body" collapses into the bundle builder.
- **`app.expressMiddleware(factory)` — Express-ecosystem middleware.** **Node-host only**, same boundary as third-party Express receivers (e.g. Slack Bolt's `ExpressReceiver`).

Ordering is preserved via the existing group-tag + `upstream/downstreamGroups` topological sort.

### Uploads (full-parity, the hard part)

multer is Express/Node/busboy-specific and cannot be the core path:

- The core parses multipart via Web **`request.formData()`**, streams each `File` to the bound `FileStore` under a UUID, and merges non-file fields back into `body` for Zod — preserving the `fileField()` + `UploadedFile` contract exactly.
- Both hosts share this one parser (the Node→Web conversion gives the Express host a `Request` whose `.formData()` works). multer leaves the core entirely (and can be optionalized — already flagged in CLAUDE.md).
- **Size limits:** multer enforced a global `fileSize` *pre-stream*; with `formData()` we enforce per-field limits by counting bytes as we stream to `FileStore` and aborting on exceed (mid-stream). Behavior parity, different mechanism.

### Downloads

`fileResponse`/`fileDownload` build a `Response` with a `ReadableStream` body + Content-Type/Disposition. `Readable.toWeb()` bridges FileStore's Node stream on the Node host; S3/edge FileStores yield Web streams directly.

## Data flow

```
host receives request
  └─ convert.ts: Node req → Web Request        (no-op on Fetch host)
      └─ RestHandler.fetch(req):
          1. middleware onion (pre)
          2. router.match(method, pathname) → {route, params}  │ no match → signal,
          3. build+validate bundle:                            │ host calls next()
               path   = params         (Zod: path schema)
               query  = URLSearchParams (Zod: query schema)
               headers= lowercased     (Zod: header schema)
               body   = await req.json()/.formData() (Zod)
          4. resolve controller via DI · weave @inject · apply(handler, bundle)
          5. validate output (response schema; log mismatch, don't throw)
          6. build Response: json | fileResponse→ReadableStream | iterator→SSE stream
          7. middleware onion (post) unwinds
  └─ convert.ts: Web Response → Node res        (no-op on Fetch host)
```

`confirmation` / `idempotency` (reading `x-confirmation-token` / `idempotency-key`) are transport-neutral — they read Web `Request` headers; an idempotent replay returns a stored `Response`.

## Error handling

`AgentError` → `buildErrorEnvelope` → `Response` (status/code + optional issues/hint). Plain `Error` → redacted 500 `internal_error`. Semantics unchanged; the only difference is handlers **return a `Response`** instead of writing to Express `res`. The envelope JSON becomes byte-identical across hosts — a parity assertion.

## Host adapters & interop matrix

| Concern | Express host (default) | Fetch host — Workers/Deno/Bun | Fastify host (follow-up) |
|---|---|---|---|
| Neutral `app.middleware` onion | ✅ | ✅ | ✅ |
| `app.expressMiddleware` / Express receivers (Slack Bolt) | ✅ | ❌ | ❌ |
| Fastify plugins | ❌ | ❌ | ✅ |
| Mount third-party router/receiver | `expressApp` getter | n/a | `fastify` getter |
| `install*` dev UIs (explorer/mcp-http/console) | ✅ | ❌ (see limitations) | ❌ (see limitations) |
| Core `@api` routes, MCP, uploads, downloads | ✅ | ✅ | ✅ |

The **Fetch host** column is one adapter (`FetchHostAdapter`) serving every
Web-standard runtime — Cloudflare Workers, Deno, and Bun — because they all take
the same `fetch(Request): Promise<Response>` entry point. Each runtime is a
~5-line wrapper around the shared `host.fetch`, not a separate port.

Rules:
- **Node hosts are mutually exclusive — Express XOR Fastify** (one host per process). The Fetch host is a third, independent option for the runtimes that have a native fetch entry point.
- **Bun is the zero-adapter case.** `Bun.serve({fetch: host.fetch})` consumes the `FetchHost` directly — no `convert.ts`, no `@hono/node-server`. (Bun can *also* run the Express host today via its `node:http` compat, but that forgoes the native fetch path.) Same shape for Deno (`Deno.serve`) and Workers (`export default {fetch}`).
- The core converting handler is **non-greedy / fallback** (match-or-`next()`), so externally mounted routes (Bolt's `/slack/events`, the UIs) front-run.
- **Raw body:** signature-verifying receivers (Bolt HMAC) need the raw body — mount them with their own raw parser / `bodyParser:false` scope (`RestServerConfig.bodyParser` already supports this), or a Fastify `'*'` content-type parser.

## Testing — how "seam proven" is earned

- **In-process Web client:** `createTestApp` gains `fetch(input, init)` calling the `FetchHostAdapter` directly (no socket) → returns a real Web `Response`.
- **Parity harness:** run existing acceptance scenarios through *both* (a) supertest → Node host and (b) the Fetch handler; assert identical status + envelope + key headers. Central evidence.
- **Regression guard:** every existing Express/supertest test stays green — the Node host behaves exactly as today.
- **Conformance:** uploads (`formData`→FileStore) and downloads (`ReadableStream`) exercised through the Fetch handler.

The Fetch handler the tests drive *is* the object that would mount on Workers — the test is the proof; no deployment required.

## Delivery — 3 stages (each a green-suite, reviewable PR)

| Stage | Ships | Gate |
|---|---|---|
| **1 · Core seam** | `convert.ts`, `router.ts`, `rest-handler.ts` (JSON routes, validation, DI, error envelope, confirm/idempotency, output validation), `host/node.ts` (RestServer slimmed, `expressApp` preserved, core as non-greedy fallback), `host/fetch.ts`; group-sorter → `common` | All existing tests green + JSON-route parity tests; **benchmark Node↔Web overhead** |
| **2 · Middleware onion** | `web/middleware.ts`, neutral `app.middleware` tier, CORS as onion entry, body-parse collapse; `app.expressMiddleware` documented Node-only | Middleware-ordering parity tests |
| **3 · Uploads + downloads** | `web/multipart.ts` (formData→FileStore, mid-stream size enforcement), `fileResponse`→`ReadableStream`, retire multer from core (optionalize dep) | Upload/download parity tests, both hosts |

## Known limitations (documented, with named follow-ups)

1. **Dev UIs are Express-host-only.** `mcp-http`, `context-explorer`, `rest-explorer`, `console` mount directly on `server.expressApp`. On the Fetch host (and a future Fastify host) they don't run until re-expressed as neutral core routes. **Follow-up:** "neutralize `install*` mounts."
2. **Subclasser breaking change.** `makeHandler`/`dispatch`/`sendResult`/`sendError` are documented `protected` override seams; their signatures change to Web `Request`/`Response`. The seams survive; the types change. Treated as an intentional, documented break (project is alpha, v0.3.0). Provide a migration note.
3. **`FastifyHostAdapter`** — not in v1; trivial follow-up because of the seam.
4. **Real edge deployment** (Workers/Deno) + **RegExpRouter** drop-in — follow-ups.

## Open decisions (recorded)

1. **`convert.ts`: hand-rolled vs `@whatwg-node/server`.** Lean hand-rolled on Node 22 globals + `Readable.toWeb/fromWeb` to avoid a dep; fall back to the library only if multipart/stream edge cases force it.
2. **Node↔Web perf** — measured in Stage 1; mitigation (fast Node path for hot routes) deferred per YAGNI unless the number is bad.
3. **`formData` per-field size limits** — enforced by counting bytes mid-stream to FileStore.
