# Fetch Seam Backlog — Plans & Designs (B–G)

> Execution branch: `feat/fetch-seam-backlog`. Item **A1 (Web streaming)** is
> already implemented + parity-proven (commits `99a2a51`, `60501b4`). This doc
> plans the rest in dependency order. Each item is implemented via
> subagent-driven-development with **Express parity as the arbiter** (the
> discipline that has caught every real bug this stage). Items are sized: 🟢
> additive/self-contained, 🟡 cross-package, 🔴 high-blast-radius (live path).

## Dependency graph

```
A1 streaming ✅ ─┐
B onion 🟡 ──────┤
C1 auth 🟡 ──────┼─→ D demotion 🔴 ─→ F1 Fastify 🟢
C2 hooks 🟡 ─────┤                    F2 neutralize UIs 🟡
C3 confirm/idem 🟡┘                   F3 RegExpRouter 🟢
E uploads/downloads 🟡 (independent of D)
G minor TODOs 🟢 (independent; safe to land anytime)
```

D (full demotion) is the keystone and depends on B + C1–C3 + A1. E and G are
independent. F1/F2/F3 follow D (host abstraction settles at demotion).

---

## B — Stage 2: middleware onion 🟡

**Problem:** the current chain is LB4 `Middleware` over `MiddlewareContext`,
whose `.request`/`.response` are Express objects (`@agentback/express`
`middleware.ts`, `toExpressMiddleware`). The Fetch path has no Express `res`.

**Design (additive, low-risk — mirrors the Part 3 choice):** introduce a
SEPARATE neutral onion for the Web path; leave the Express chain untouched.
- New type `WebMiddleware = (req: Request, ctx: Context, next: () => Promise<Response>) => Promise<Response>` in `@agentback/rest` (`web/middleware.ts`).
- Register via a binding tag (`WEB_MIDDLEWARE`); order with the EXISTING `sortListOfGroups` (relocate `group-sorter.ts` from `@agentback/express` → `@agentback/common` so `rest` uses it without depending on `express` — DRY, pure util).
- `RestHandler`/`FetchHost` runs the sorted onion around dispatch: `mw1(req, ctx, () => mw2(req, ctx, () => core(req)))`.
- CORS becomes a built-in `WebMiddleware` (group `cors`); body-parse is a no-op on the Web path (Web `Request` lazily exposes `.json()/.formData()`).
- `app.middleware(fn)` stays Express-only for now; a Web equivalent is `app.webMiddleware(fn)` (or `app.middleware` learns to register both at demotion — defer the unification to D).
- **`app.expressMiddleware` documented Node-host-only.**

**Tasks:** (1) relocate group-sorter to common + reexport shim; (2) `web/middleware.ts` onion runner + tag; (3) wire into `createFetchHost` (or `RestHandler`); (4) built-in CORS WebMiddleware; (5) unit tests (ordering via groups, short-circuit, CORS preflight) + a parity check that ordering matches the Express chain's topological sort. **Arbiter:** ordering parity test.

---

## C1 — auth/authz on the Web path 🟡

**Problem:** `RestServer.authenticate(req, ctor, methodName)` + `authorize` read
the Express `req` (headers, etc.) and resolve strategies from
`@agentback/authentication`, whose strategy contract is Express-typed.

**Design:** add a neutral seam to the auth strategy contract — strategies should
authenticate from a transport-neutral carrier (method + URL + headers map),
which both Express `req` and Web `Request` can supply. Two sub-steps:
- In `@agentback/authentication`: introduce `AuthRequest` (a minimal `{method, url, headers: Headers | Record, get(name)}`), adapt `resolveStrategy`/the strategy interface to accept it; provide an Express adapter (wrap `req`) and a Web adapter (the `Request` itself). Keep the existing Express signature working (overload or adapter) — additive.
- In `RestHandler`: call the neutral `authenticate`/`authorize` before `run()`, binding `SecurityBindings.USER`/`CLIENT_APPLICATION` on `reqCtx` (same as `invokeRoute`).

**Tasks:** auth-package neutral request seam + adapters + tests; RestHandler auth/authz step; parity test (a `@authenticate`d route returns identical 401/200 on both surfaces). **Arbiter:** auth parity test. 🟡 cross-package — bump `@agentback/authentication` carefully.

---

## C2 — dispatch hooks on the Web path 🟡

**Problem:** `RestDispatchInfo` carries Express `req`/`res`; hooks (`tracing`,
`metering`, …) consume them.

**Design:** make `RestDispatchInfo` transport-neutral. Replace `req: ExpressRequest; res: ExpressResponse` with `request: Request` (Web) + `ctx: Context`; drop `res` (hooks observe, they don't write — verify against the OTel/metering hooks). The Express path adapts its `req`→a Web `Request` view (or keeps a back-compat field during transition). `RestHandler` resolves the hook chain (`resolveDispatchHooks`) and wraps `run()` exactly like `RestServer.dispatch`.

**Tasks:** neutralize `RestDispatchInfo` (audit `extension-otel`/`metering` consumers + migrate); RestHandler hook-wrapping; parity test (a bound hook fires identically on both surfaces). **Arbiter:** hook-fires parity + the otel/metering suites stay green. 🟡 touches the public hook contract — document the break.

---

## C3 — confirmation/idempotency on the Web path 🟡

**Design:** port `enforceConfirmation` (reads `req.method/path/params/body` for
the fingerprint + `x-confirmation-token`) and `executeIdempotent` (reads
`idempotency-key`, replays a stored result) to read the Web `Request`. The
stores (`ConfirmationStore`/`IdempotencyStore`) are already neutral. An
idempotent replay returns a `Response`.

**Tasks:** neutral confirm/idempotency helpers (extract the fingerprint/replay
logic shared with `RestServer`); RestHandler integration; parity tests
(first-call 409 + token retry; idempotent replay). **Arbiter:** parity tests.

---

## D — full Express demotion 🔴

**Depends on:** A1 ✅, B, C1, C2, C3. Once the Web pipeline does auth + hooks +
confirm/idem + streaming, `RestServer` can stop owning per-route dispatch.

**Design:** `RestServer` mounts ONE Express handler that converts `req`→Web
`Request`, runs the (now full-featured) core handler, and writes the `Response`
back via `@hono/node-server` primitives — as a **non-greedy fallback** so
externally-mounted Express routes (Slack Bolt, `install*` UIs) front-run. Remove
the per-route `app[verb](...)` registration + `makeHandler`/`dispatch`/
`invokeRoute`/`sendResult`/`sendError`/`sendStream` (now superseded by
`RestHandler`). `app.middleware` unifies to register the neutral onion (runs on
both hosts). Preserve `start`/`stop`/`url`/`expressApp` exactly.

**Tasks:** non-greedy Express fallback mount; delete superseded dispatch code;
unify `app.middleware`; FULL parity sweep (every existing rest acceptance test
must pass through the new path — this is the regression guard). **Arbiter:** the
entire existing `@agentback/rest` + examples suite, unchanged, green. 🔴 highest
blast radius — do last, behind a full green suite, ideally with a feature flag
(`rest: {dispatch: 'web' | 'express'}`) to allow rollback.

---

## E — Stage 3: uploads + streaming downloads 🟡 (independent of D)

**Design (already in the spec):** multipart via Web `request.formData()` →
stream each `File` to the bound `FileStore` under a UUID (retire multer from the
core path; both hosts share the parser); `fileResponse`/`fileDownload` build a
`Response` with a `ReadableStream` body (`Readable.toWeb` bridges Fs/S3 streams).
Per-field size enforced by counting bytes mid-stream.

**Tasks:** `web/multipart.ts` (formData→FileStore); `RestHandler` upload bundle
+ download Response; size-limit enforcement; conformance + parity tests vs the
Express multer path (`examples/hello-uploads`). **Arbiter:** upload/download
parity + the files conformance suite.

---

## F — host & ecosystem (after D)

- **F1 FastifyHostAdapter 🟢** — `createFastifyHost`/adapter: register the core
  as Fastify's `setNotFoundHandler` (non-greedy), convert `request.raw`→Web via
  the same `@hono/node-server` primitives, expose `fastify` getter, `'*'`
  content-type parser for raw body. ~adapter + a smoke test.
- **F2 neutralize `install*` UIs 🟡** — re-express `context-explorer`,
  `schema-explorer`, `rest-explorer`, `mcp-inspector`, `console`, `mcp-http`
  mounts as neutral routes/handlers so they run on Fetch/Fastify hosts (today
  they `app.use`/`app.get` on `expressApp`). Largest of F; can be staged per-UI.
- **F3 RegExpRouter 🟢** — replace the linear `Router.match` scan with a
  compiled-regex matcher (Hono's approach); keep the D7 specificity + decode
  semantics. Pure perf; guarded by the existing router unit suite + a benchmark.

---

## G — minor TODOs 🟢 (safe anytime)

- **WEB_REQUEST binding key** — add `RestBindings.WEB_REQUEST` (typed `Request`);
  `RestHandler` binds it instead of `HTTP_REQUEST.to(req as never)`. Drop the cast.
- **Dedup `resolveController`** — extract the shared DI lookup (currently in both
  `RestServer` and `RestHandler`) into a small helper.
- **`dispatch.ts` JSDoc** — trim the "Part 1/Part 2" diary phrasing to a plain
  contract description.
- **Copyright-header normalization** — repo-wide `Ninemind.ai 2026` vs the
  CLAUDE.md canonical; a mechanical sweep (separate PR; ~all source files).
- **Edge-deploy guide (not code)** — `docs/guides/deploy-to-edge.md` + a
  `Bun.serve`/`Deno.serve`/Workers `export default {fetch}` snippet using
  `RestServer.fetchHandler()`. "Real edge deploy" is documentation + an example,
  not framework code.

---

## Execution order

1. **G** (safe quick wins; clears the WEB_REQUEST cast + dedup before more code piles on it).
2. **B**, **C1**, **C2**, **C3** (the Web pipeline layers — each parity-gated, additive).
3. **E** (independent; can interleave).
4. **D** (demotion — only after B+C green; full-suite-gated, flagged for rollback).
5. **F1/F2/F3** (post-demotion host/ecosystem).

Each lands as its own commit(s) on `feat/fetch-seam-backlog` with parity tests;
periodic merges to `main` at safe checkpoints (after B, after C, after D, after E/F).
