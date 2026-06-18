# Plan 006 — Phase 2: `EdgeRestApplication` / `ExpressRestApplication` so edge apps don't install `express`

**Written against commit:** `c3b4d77` (verify with `git rev-parse --short HEAD`).
**Package(s):** a new neutral middleware package, `@agentback/express` (becomes the optional host), `@agentback/rest`, every consumer that imports middleware symbols from `@agentback/express`.
**Effort:** L for the core (P2.1–P2.3: neutral extraction + the two app classes + drop express from the edge install); P2.4 (full feature parity on the fetch path) is open-ended. **Do NOT execute in one pass.** Phased; each phase independently shippable + verifiable.
**Status:** TODO (design; P2.0 measured).
**Depends on / relates to:** Plans 004 + 005 (the Phase-1 seams this builds on). The core is **NOT** gated on the item-D global default flip — the two-class design replaces that with an explicit per-app class choice; `docs/superpowers/specs/2026-06-16-fetch-seam-root-cutover.md` (B/C/F2 items) is only relevant to P2.4's incremental feature porting.

---

## The goal, precisely

After Phase 1 (plans 004/005), `express` is kept out of the edge **bundle** (proven: cf-app bundle doctor `{ok:true}` + a live Workers deploy). It is still in the edge app's **install** tree. Phase 2's goal: **a fetch-only / `listener: 'native'` app's `node_modules` contains no `express` (and no `cors`).**

## Why "drop express from rest's dependencies" is a no-op (the real blocker)

`express` reaches an app through a transitive runtime path, not rest's direct dep:

```
@agentback/rest  ──(runtime: RestApplication extends MiddlewareMixin(Application), rest.application.ts:28)──▶
@agentback/express  ──(hard dep)──▶  express
```

So removing `express` from `@agentback/rest`'s `dependencies` changes nothing about install — it still arrives via `@agentback/express`. To make `express` genuinely optional, **`@agentback/rest` must stop pulling `@agentback/express`'s express runtime at all**, which means `@agentback/express` must be split so the part `rest` needs (the neutral middleware machinery) carries no `express` dependency.

## The boundary already exists (good news)

Within `@agentback/express`, the express **runtime** is confined to a small set of modules (verified at `c3b4d77`). Assign every module:

| Module | Express runtime? | Phase-2 home |
|---|---|---|
| `types.ts` | no express (imports `on-finished` only) | **neutral** |
| `keys.ts` | no | **neutral** |
| `group-sorter.ts` | no | **neutral** |
| `middleware.ts` | no | **neutral** |
| `middleware-interceptor.ts` | no express (`on-finished` only) | **neutral** |
| `middleware-registry.ts` | no | **neutral** |
| `mixins/middleware.mixin.ts` | no | **neutral** |
| `providers/invoke-middleware.provider.ts` | no | **neutral** |
| `express.server.ts` | **yes** (`import express`) | **host** |
| `express.application.ts` | yes (via ExpressServer) | **host** |
| `express-service.ts` | **yes** (`import express`, `cors`) | **host** |
| `express-service-keys.ts` | no (key + type) | **host** (co-located with the service; key is import-safe) |
| `express-component.ts` | yes (imports the service class) | **host** |

`rest` only imports neutral modules on its runtime/edge path (`@agentback/express/mixins/middleware.mixin`, `/keys`, `/types`, the `ExpressMiddlewareFactory` type). The host modules are reached only via the Phase-1 `ExpressService` seam / the createRequire loaders.

**Caveat — `on-finished`:** the neutral `types.ts` + `middleware-interceptor.ts` runtime-import `on-finished`. It is tiny, edge-safe (not in the bundle-doctor DENY list, used only by `MiddlewareContext` which is Express-path), and stays with the neutral package. Not a blocker, but note it so the neutral package isn't mistaken for zero-runtime-deps.

## Design — two application classes over a split package

The mechanism is **two host-specific `Application` subclasses**, backed by a **package split**. The class split is the API shape; the package split is the dependency plumbing that makes the edge class genuinely express-free. Both are required — the class split alone doesn't drop express from install (because `RestServer` itself imports `@agentback/express`'s neutral modules at runtime), and the package split alone leaves the awkward "flip the global default" migration.

### The two classes

- **`EdgeRestApplication`** (neutral) — `extends Application`, pre-wired to `listener: 'native'`, exposes `app.webMiddleware` + `fetchHandler()`. **No Express mixin, no `express`/`cors` dependency.** Serves every fetch host (Workers/Bun/Deno/Fastify/Hono/Node-native) by wrapping its `fetchHandler()`. This is just the native path that already works (and deployed live in Phase 1), packaged as a first-class express-free entry point.
- **`ExpressRestApplication`** (host) — `extends MiddlewareMixin(Application)` (today's `RestApplication`), defaults to `listener: 'express'`, adds `app.middleware`/`app.expressMiddleware` and the Express middleware chain. Pulls `@agentback/express` + `express`/`cors`.

Express-coupled features (raw `@inject(HTTP_REQUEST/RESPONSE)`, dispatch-seam subclasses, `expressMiddleware`) live **only** on `ExpressRestApplication` — unrepresentable on the edge class by construction, not a runtime error. The install\*/extension UIs that only mount on Express are likewise edge-unavailable until re-expressed (F2), but that becomes "not offered on the edge host yet" rather than "broken."

> **You only need two classes, not one per runtime.** Fastify/Bun/Deno/Workers are hosts wrapped around `EdgeRestApplication`'s `fetchHandler()`, not subclasses. `@agentback/express` already ships an `ExpressApplication` as prior art for a host-specific `Application` subclass.

### Naming / back-compat (decision required at execution)

- **Non-breaking (RECOMMENDED):** keep today's `RestApplication` = Express (unchanged behavior + deps), add `EdgeRestApplication` = neutral. Existing apps untouched; edge is purely additive/opt-in. Optionally alias `ExpressRestApplication = RestApplication` for naming symmetry.
- **Cleaner-but-breaking:** make `RestApplication` the neutral base and add `ExpressRestApplication` for the host. Better long-term names; every existing app re-imports. Defer to a major version.

### The package split (the plumbing under the classes)

- `@agentback/middleware` — NEW neutral package: `types`, `keys`, `group-sorter`, `middleware`, `middleware-interceptor`, `middleware-registry`, `mixins/middleware.mixin`, `providers/invoke-middleware.provider`. Deps: `@agentback/core`/`context`/etc. + `on-finished`. **No `express` hard dep** (`@types/express` devDep for types; `express` devDep for tests).
- `@agentback/express` — stays the Express HOST: `express.server`, `express.application`, `express-service`, `express-component`, `express-service-keys`. Deps: `express`, `cors`, `body-parser`, the neutral package.
- `@agentback/rest` depends on `@agentback/middleware` (no express). `EdgeRestApplication` + `RestServer` resolve all their middleware/chain symbols from the neutral package. `ExpressRestApplication` is the one class that pulls `@agentback/express`; it can live in `@agentback/rest` only if rest keeps an (optional) link to the host — cleanest is to ship `ExpressRestApplication` from `@agentback/express` (or a thin `@agentback/rest-express`) so `@agentback/rest` itself has no express in its dependency closure.

> **Alternative considered (package side):** keep one `@agentback/express` and make `express`/`cors` optional `peerDependencies`, lazy-loading them in the host modules. Rejected as primary: re-introduces the createRequire hack and an "express package without express" is confusing. The split is the clean end state; this is the fallback if the split is too costly.

## Why this beats "flip the default listener"

The earlier framing was: make `listener: 'native'` the global default (fetch-seam "item D / full demotion"). That is a **behavioral migration** — every app using Express-coupled features silently breaks, and the exit criterion ("full suite green under native") is unreachable because some features are Express-only by design. The two-class design replaces that with an **explicit, opt-in class choice**:

- No global default flip, no migration — existing apps keep `RestApplication`.
- Express-only features are excluded *by construction* on `EdgeRestApplication`, not by a runtime guard you can trip.
- Parity gaps (P2.0 below) are **rescoped, not gating**: `EdgeRestApplication` simply doesn't offer un-ported features (install\* UIs, configurable body-parser) until F2/B/C land. You ship the edge class without closing the whole backlog.

The remaining gate is therefore just: the neutral-package extraction (P2.1) + whatever subset of fetch parity `EdgeRestApplication` must guarantee (a deliberately small, documented surface — `@api` routes, framework routes, MCP-over-fetch), NOT full native parity.

**Item D's exit criterion is nuanced, not "the whole suite passes under native":** native intentionally CANNOT serve Express-coupled routes (raw `@inject(HTTP_REQUEST/HTTP_RESPONSE)`, dispatch-seam subclasses, `app.expressMiddleware`). Those must (a) keep working under an explicit `listener: 'express'` + host, and (b) fail loudly under native (the `assertNoExpressCoupledRoute` guard, already in place). The real criterion: *the non-Express-coupled suite + examples pass under native default; Express-coupled features pass under explicit express mode; the split changes neither.*

## Phased execution (each phase ships + verifies independently)

**P2.0 — Measure the gate (do this FIRST; read-only).** Temporarily set the listener default to `'native'` (`rest.server.ts` `cfg.listener ?? 'native'`), rebuild, run the full suite + examples, and catalog every failure into "Express-coupled-by-design" vs "native parity gap." This sizes item D and must inform whether to proceed. Revert the temporary flip. Deliverable: a gap list. **Do not continue to P2.1 until this is understood.**

### P2.0 RESULTS (measured 2026-06-18 @ `c3b4d77`+flip)

Flipped the listener default to `'native'`, full `vitest run`: **45 failed / 2313 passed / 33 skipped.** Categorized by failure reason:

| Category | ~count | What it is | Verdict |
|---|---|---|---|
| **Express-coupled-by-design** | 3 | `assertNoExpressCoupledRoute` correctly fired: raw `@inject(HTTP_REQUEST/RESPONSE)` (`req-injection`) + dispatch-seam subclasses (`EnvelopeRestServer`, `AuditRestServer` in `rest-server.integration`). | **Not a gap.** These tests just need explicit `listener: 'express'`. Native behaving correctly. |
| **install\*/extension/UI routes 404 on native** | ~28 | Routes mounted via `app.get`/`app.use` on `expressApp` (not `addFetchHandler`): `extension-health` (/health, /ready), `extension-metrics` (/metrics), `console`, `rest-explorer`, `mcp-inspector`, `mcp-http` + `per-session`, `mcp-connect`, `chat` webhook. The fetch router doesn't know them → 404. | **Real gap = fetch-seam backlog item F2** ("neutralize install\* UIs") + extension route re-expression. Large. |
| **body-parser / CORS / raw-body config** | ~9 | The web path parses bodies via `Request.json()/formData()` and does NOT honor the Express `bodyParser` config (`text`/`raw`/`urlencoded`) or CORS-origin/raw-byte semantics identically (`body-parser.integration`, chat raw-body, a CORS-origin assertion). | **Real gap = backlog items B/C** (web body-parse + CORS parity). |
| **dispatch hooks / auth / metering parity** | ~5 | A few `expected 'authorize'/'connected'/401` — dispatch hooks, authz, and `mcp-connect` state not firing identically on the web path. | **Real gap = backlog items C1/C2.** |

**Go/no-go verdict (re-evaluated under the two-class design): the core is achievable; the parity gaps SCOPE the edge class, they don't gate it.** The 45 failures were measured against the *old* "flip the global default" approach, where every gap blocks. Under `EdgeRestApplication`, those features are simply **not offered on the edge host until ported** — so the ~42 gaps stop being a wall and become a prioritized backlog. The ~3 Express-coupled-by-design failures are non-issues (those features live only on `ExpressRestApplication`). What's left to *ship the edge class* is P2.1 (extraction) + a small, documented edge surface (`@api` routes, framework routes, MCP-over-fetch — all already passing). **Recommendation: still sequence carefully (P2.1 is a real package move), but Phase 2 is no longer blocked on closing the whole fetch-seam backlog.** Phase 1 already delivers express-out-of-bundle; this adds express-out-of-install for edge apps, incrementally.

**P2.1 — Extract the neutral package (no behavior change).** Create `@agentback/middleware`; move the 8 neutral modules; `@agentback/express` depends on + re-exports it (back-compat); point `@agentback/rest`'s + `RestServer`'s subpath imports at the neutral package; add to `tsconfig.json` refs + `pnpm-workspace`. **`express` not removed anywhere yet.** Verify: `pnpm verify` green; cf-app bundle doctor `{ok:true}`; live Workers deploy 200s.

**P2.2 — Introduce `EdgeRestApplication` + `ExpressRestApplication`.** Per the naming decision above (recommended non-breaking: keep `RestApplication`=Express, add `EdgeRestApplication`=neutral). `EdgeRestApplication` extends `Application`, pre-wires `listener: 'native'`, exposes `webMiddleware` + `fetchHandler()`, lives in a package with NO express in its closure. Document its supported surface explicitly (`@api`, `/openapi.json`, `/llms.txt`, MCP-over-fetch). Verify: an `EdgeRestApplication` fixture builds + serves via `fetchHandler()`; bundle doctor `{ok:true}`; live Workers deploy of an `EdgeRestApplication` (not the current `createFetchHost` stand-in) serves 200s.

**P2.3 — Drop express from the edge install path (the payoff).** Ensure `@agentback/rest`'s dependency closure (as used by `EdgeRestApplication`) contains no `express`/`cors`; ship `ExpressRestApplication` + the host from `@agentback/express` (or `@agentback/rest-express`) so Express apps opt in. Verify: scaffold an `EdgeRestApplication` app, `pnpm install`, assert `[ ! -d node_modules/express ]`; `ExpressRestApplication` app still has it and works.

**P2.4 (optional, incremental) — Port install\*/extension UIs + body-parser/CORS/hooks parity to the fetch path** (the P2.0 gap backlog: F2 + B/C1/C2), expanding `EdgeRestApplication`'s supported surface one feature at a time. Each is independently shippable; none blocks P2.1–P2.3.

## Done criteria (the Phase-2 payoff, at P2.3)

- A fresh `EdgeRestApplication` app install has **no `express`/`cors`** in `node_modules` (`[ ! -d node_modules/express ]`).
- `ExpressRestApplication` (Express host) still works end-to-end — the full existing Express suite green, unchanged.
- `EdgeRestApplication` serves its documented surface on a live Workers deploy; `pnpm verify` green; cf-app bundle doctor `{ok:true}`.

## Breaking changes / migration (must be in release notes)

- Middleware symbols (`MiddlewareMixin`, `MiddlewareGroups`, `MiddlewareContext`, `registerExpressMiddleware`, `toExpressMiddleware`, the chain types) **move** from `@agentback/express` to `@agentback/middleware`. Provide a back-compat re-export from `@agentback/express` for one release where possible; document the new import path.
- Apps pick `EdgeRestApplication` (no express) or `ExpressRestApplication` (= today's `RestApplication`, recommended non-breaking naming) at construction — no global default flip, no migration for existing apps.
- Express host apps depend on `@agentback/express` explicitly (it stops being transitively guaranteed for edge apps once `EdgeRestApplication` ships from the neutral closure).
- `create-agentback` templates split: an edge template (`EdgeRestApplication`, no express) vs an Express template (`ExpressRestApplication` + express).
- The neutral package move is the breaking part (moved middleware exports). With the non-breaking class naming + a one-release back-compat re-export, this can be a minor bump; the breaking class rename (option 2) would be major — defer it.

## Risks / escape hatches

- **Blast radius:** the symbol move touches every importer of `@agentback/express`'s middleware exports across the repo. Grep them all before moving; a missed importer is a build break, not silent. STOP and inventory before P2.1.
- **The two-class design defuses the old "item D is the real cost" risk.** Because `EdgeRestApplication` ships with a *documented, deliberately-small* supported surface, you no longer need full native parity before shipping — the P2.0 gaps (F2/B/C) become an incremental backlog (P2.4) that expands the edge surface over time, not a wall in front of P2.1–P2.3. Don't re-import the "must close everything first" assumption.
- **`on-finished`** stays in the neutral package — don't try to make it zero-runtime-dep; it's edge-safe.
- If at P2.1 the back-compat re-export from `@agentback/express` re-introduces `express` onto the neutral graph (a re-export pulling a host module), STOP — re-export only the neutral symbols, never the host.
- Scope the edge surface HONESTLY: `EdgeRestApplication` must throw a clear "this feature requires ExpressRestApplication" (or omit the method entirely) for anything not yet ported, so users hit a signpost, not a silent 404 — the same lesson as the generated-worker `listener:'native'` footgun.

## Note on value (read before starting)

Phase 1 already delivered the property most apps care about: **express is not in the edge bundle**, and the seam is injectable/testable. Phase 2 adds **express not in the edge install** (smaller `node_modules`, less supply-chain surface) for apps that pick `EdgeRestApplication`. The two-class design makes this incrementally shippable (P2.1 extraction → P2.2 the class → P2.3 the install drop), rather than a single XL effort gated on a global default flip. The honest framing: P2.1–P2.3 is a contained, valuable increment; P2.4 (porting every Express feature to the fetch path) is open-ended and should be demand-driven.
