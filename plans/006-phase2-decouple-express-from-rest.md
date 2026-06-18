# Plan 006 — Phase 2: decouple `@agentback/rest` from the Express runtime so edge apps don't install `express`

**Written against commit:** `c3b4d77` (verify with `git rev-parse --short HEAD`).
**Package(s):** `@agentback/express` (split), a new neutral package, `@agentback/rest`, every consumer that imports middleware symbols from `@agentback/express`.
**Effort:** XL — multi-step package restructure + gated on the item-D default-listener flip. **Do NOT execute in one pass.** This is a design spec + phased plan; each phase is independently shippable and verifiable.
**Status:** TODO (design).
**Depends on / relates to:** Plans 004 + 005 (the Phase-1 seams this builds on), and `docs/superpowers/specs/2026-06-16-fetch-seam-root-cutover.md` ("item D / full demotion" — the default-listener flip this is gated on).

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

## Design — split into a neutral package + an optional host package

**Recommended naming (decide at execution):**
- `@agentback/middleware` — NEW neutral package: `types`, `keys`, `group-sorter`, `middleware`, `middleware-interceptor`, `middleware-registry`, `mixins/middleware.mixin`, `providers/invoke-middleware.provider`. Deps: `@agentback/core`/`context`/etc. + `on-finished`. **No `express` hard dep** (`@types/express` as a devDep for the type imports; `express` stays a devDep for tests).
- `@agentback/express` — stays the Express HOST: `express.server`, `express.application`, `express-service`, `express-component`, `express-service-keys`. Deps: `express`, `cors`, `body-parser`, the neutral package. Re-exports the neutral package for back-compat where feasible.

`@agentback/rest` depends on `@agentback/middleware` (no express) + (optionally, opt-in) `@agentback/express` the host. `express`/`cors` leave rest's direct deps; the host package provides them when present.

> **Alternative considered:** keep one package and make `express`/`cors` optional `peerDependencies` of `@agentback/express`, lazy-loading them in `express.server`/`express-service` (the createRequire pattern). Rejected as the primary path: it re-introduces the lazy-load hack inside the host modules and an "express package that doesn't depend on express" is confusing. The split is the clean end state. (If the split proves too costly, this is the fallback.)

## The gate — item D (default listener → native)

Even after the split, the **default** app must not require the host. Today the default listener is `'express'` (`DEFAULT_REST_CONFIG`), so a default `new RestApplication()` mounts on Express and needs the host. Two ways past the gate, both = item D territory:

1. **Flip the default listener to `'native'`** (`fetchHandler()` as the single router). Then default apps don't touch Express; only apps that opt into the Express host install it. This is the `fetch-seam-root-cutover` "item D / full demotion".
2. **Require Express apps to opt in** (add the host package + `ExpressComponent`, or set `listener: 'express'` explicitly with the host installed). A smaller default-UX break than (1) but still breaking.

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

**Go/no-go verdict: DEFER Phase 2 (do NOT proceed to P2.1 now).** ~42 of the 45 failures are genuine native-parity gaps spanning the fetch-seam backlog's B / C1 / C2 / F2 items (install UIs, extension routes, web body-parsing, CORS, hooks, auth). Item D (native as the default) is **far** — closing these is a multi-plan effort, and it is the true cost of Phase 2, exactly as this spec warned. Phase 1 already delivered the property most apps want (express out of the edge **bundle**); Phase 2's marginal gain (express out of the edge **install**) does not justify the item-D effort yet. Revisit when/if the fetch-seam backlog (B/C/F2) is being closed for other reasons — then Phase 2's P2.1 split falls out cheaply.

**P2.1 — Extract the neutral package (no behavior change).** Create `@agentback/middleware`; move the 8 neutral modules; update `@agentback/express` to depend on + re-export it (back-compat); update `@agentback/rest`'s subpath imports to point at the neutral package; add the new package to `tsconfig.json` refs + `pnpm-workspace`. **`express` is NOT yet removed anywhere.** Verify: `pnpm verify` green; cf-app bundle doctor `{ok:true}`; a real Workers deploy still serves 200s.

**P2.2 — Close the native parity gaps from P2.0** (whatever non-Express-coupled features the native path lacks). This is the bulk of item D and may itself be multiple plans. Verify per gap with parity tests.

**P2.3 — Flip the default to native (item D)** behind the agreed criterion; Express-coupled features documented as requiring `listener: 'express'` + the host package. Verify: full suite green (native default for neutral features, explicit express for coupled ones); examples updated.

**P2.4 — Make the host optional + drop express from rest.** `@agentback/rest` drops `express`/`cors` from `dependencies` and depends on `@agentback/middleware` (not the host). `@agentback/express` host is opt-in (apps/templates that use Express add it). Verify the payoff: scaffold a `listener: 'native'` app, `pnpm install`, and assert `node_modules/express` is ABSENT; `pnpm verify` green; bundle doctor `{ok:true}`; live edge deploy 200s.

## Done criteria (the Phase-2 payoff, at P2.4)

- A fresh fetch-only / native app install has **no `express` and no `cors`** in `node_modules` (machine-check: `[ ! -d node_modules/express ]`).
- An Express app (opting into the host) still works end-to-end (the full Express suite green).
- `pnpm verify` green; cf-app bundle doctor `{ok:true}`; live Workers deploy 200s.

## Breaking changes / migration (must be in release notes)

- Middleware symbols (`MiddlewareMixin`, `MiddlewareGroups`, `MiddlewareContext`, `registerExpressMiddleware`, `toExpressMiddleware`, the chain types) **move** from `@agentback/express` to `@agentback/middleware`. Provide a back-compat re-export from `@agentback/express` for one release where possible; document the new import path.
- Express host apps must depend on `@agentback/express` explicitly (it stops being transitively guaranteed once rest drops it) and add `ExpressComponent` / set `listener: 'express'`.
- `create-agentback` templates split: a native/edge template (no express) vs an Express template (adds `@agentback/express` + express).
- Requires a lockstep MAJOR-ish bump given the moved public API.

## Risks / escape hatches

- **Blast radius:** the symbol move touches every importer of `@agentback/express`'s middleware exports across the repo. Grep them all before moving; a missed importer is a build break, not silent. STOP and inventory before P2.1.
- **Item D is the real cost,** not the split. If P2.0 shows a large native parity gap, Phase 2's payoff (smaller edge `node_modules`) may not justify the effort — surface that to the maintainer with the gap list before P2.2. The honest "stop" branch (plan-006 option D) remains valid.
- **`on-finished`** stays in the neutral package — don't try to make the neutral package zero-runtime-dep; it isn't, and that's fine (it's edge-safe).
- If at P2.1 the back-compat re-export from `@agentback/express` re-introduces `express` onto rest's graph (because the re-export pulls a host module), STOP — re-export only the neutral symbols, never the host.

## Note on value (read before starting)

Phase 1 already delivered the property most apps care about: **express is not in the edge bundle**, and the seam is injectable/testable. Phase 2's marginal gain is a smaller `node_modules` for edge installs. That is real (cold-start install size, supply-chain surface) but is a large effort gated on item D. Treat P2.0's gap list as the go/no-go: if item D is far, prefer to defer Phase 2 rather than carry a half-split package set.
