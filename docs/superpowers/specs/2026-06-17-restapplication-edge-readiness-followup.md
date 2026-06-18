# Full `RestApplication` Edge-Readiness — Follow-up Spec

**Date:** 2026-06-17 (resolved 2026-06-18)
**Status:** ✅ **DONE** — a real `RestApplication` is deployed and verified on Cloudflare Workers.
**Origin:** During Phase 2a implementation, the accurate bundle doctor correctly reported that a real `RestApplication` worker does **not** bundle clean for a Cloudflare Workers isolate. The deploy tooling + doctor shipped; making a real app actually run on the edge is this separate initiative.

---

## Resolution (2026-06-18)

A real `RestApplication` (the `packages/cli/fixtures/cf-app` fixture) now **deploys and runs** on Cloudflare Workers — `agentback deploy cloudflare` serves `/openapi.json`, `/ping`, and `/llms.txt` all `200` on `workers.dev`. Landed in two commits on `design/agentback-deploy`:

- **`ca2300d` — bundle-clean** (the static graph; this spec's original scope).
- **`d16e913` — runtime-clean** (a second class of failure this stub did **not** anticipate — see below).

### Layer 1 — bundle-clean (`ca2300d`)

The transitive-tail prediction below was directionally right but mis-attributed the root cause. The real driver was **barrel topology**, not per-dep node usage. Final fixes (only `node:fs`/`node:fs/promises`/`node:net` actually fail the `nodejs_compat` doctor):

- **Express was still static** — `@agentback/rest` imported a constant (`rest/keys.ts`) and `MiddlewareMixin` (`rest/rest.application.ts`) from the `@agentback/express` **barrel**, which re-exports `express.server`/`express.application` → the whole Express runtime (`view.js`=`node:fs`, `request.js`=`node:net`, + `etag`/`send`/`cookie-signature`). Fix: made `@agentback/express`'s `types.ts` express imports type-only, added subpath exports (`./types`, `./keys`, `./mixins/middleware.mixin`), and pointed `rest` at the subpaths (never the barrel). This alone removed `node:net` and the entire etag/send/cookie tail.
- **multer** (`rest/multipart.ts`) — `import type multer` + lazy runtime via `getBuiltinModule`+`createRequire`; loads only when an upload route mounts.
- **`@agentback/files` `FsFileStore`** — moved off the barrel to a `@agentback/files/fs` subpath so `FILE_STORE`/`FileStore` importers don't pull `node:fs`.
- **`fromDisk` (`asset-source-disk`)** — **NOT** lazy-loaded (that defeats the doctor's intentional `Entry B` detection of Node-only asset sources). Real fix: `rest/index.ts` changed `export * from './host/static.js'` → a **named** re-export, so esbuild tree-shakes the unused `fromDisk`/`serveStaticDir` (star re-exports are retained conservatively; named ones tree-shake under `sideEffects:false`).

### Layer 2 — runtime-clean (`d16e913`) — what the stub missed

**The bundle doctor is a *static* analyzer; bundle-clean ≠ runtime-clean.** A worker that bundles `{ok:true}` still crashed on Workers in two ways the doctor cannot see:

1. **Global-scope ops** — Workers forbid generating random values / IO / timers at module-load (global scope). `@agentback/context`'s `unique-id.ts` ran `hyperid()` at import, which seeds a random UUID at construction → startup-validation crash. Fix: `generateUniqueId` now delegates to `@agentback/common`'s `generateIdSync` (nanoid-backed; randomness only on call). Also removed the dead deprecated `uuid()` helper + `UUID_PATTERN` from `value-promise.ts`; dropped `hyperid` + `uuid` from `context`.
2. **Runtime Node-API reach** — `RestServer.start()` mounted `@api` routes on Express via `ensureExpressApp()` → `createRequire(import.meta.url)`; `import.meta.url` is `undefined` on a Worker (and express isn't bundled). Fix: in **`listener: 'native'`** mode, `start()`/`mountFrameworkRoutes()`/`mountAxRoutes()` skip **all** Express mounting — `fetchHandler()` is the single router via `collectRoutes()`. **Edge apps must set `rest: {listener: 'native'}`** (the cf-app fixture does). Express mode is unchanged.
3. Also hardened `@agentback/common`'s `loadEnvFiles` guard: `nodejs_compat` **fakes** `process.versions.node`, so the guard additionally requires a `file:` `import.meta.url` and wraps the body in try/catch (optional `.env` loading must never crash a worker).

### Regression posture

Full `pnpm verify` (2350 tests) green throughout; Node Express/upload/cookie behavior unchanged (the doctor's `Entry A`/`Entry B` tree-shaking tests and the rest acceptance suite all pass). Acceptance met: doctor `{ok:true}` **and** a real `wrangler deploy` serving `/openapi.json` 200.

### Follow-ups (not yet done)

- A `wrangler dev`-based CI smoke test (boot the worker, hit `/openapi.json`) would catch *runtime* regressions without a credential-gated real deploy — neither the doctor nor `pnpm verify` would have caught Layer 2.
- `auto`-detect or document `listener: 'native'` in the generated worker so edge users don't have to set it by hand.

---

## Original analysis (historical — superseded by the Resolution above)


## Problem

A worker that does `await buildApp({listen:false}) → app.restServer → fetchHandler()` for a real `RestApplication` pulls **edge-hostile Node-only code** into its bundle. The `fetchHandler()` logic is already runtime-neutral, but the framework's request/host stack drags in Express + its transitive ecosystem.

## What's already done (landed in Phase 2a)

- **Accurate bundle doctor** (`@agentback/cli`): `nodejs_compat`-aware DENY list (allows `node:path`/`node:crypto`/`node:http`/etc.; denies real-incompatibles `node:fs`/`child_process`/`net`/`tls`/…), and catches **bare-name** builtins (so `dotenv`'s bare `fs` is seen). This is the gate that honestly tells you what's edge-incompatible.
- **`@agentback/common` dotenv/env edge-safe** (commit `02f8060`): env loading no longer pulls `dotenv`/`node:fs` into the static graph (runtime-resolved via `process.getBuiltinModule` + `createRequire`); Node `.env` auto-load unchanged. The barrel `import {loggers}` is edge-clean.
- **Starting point for lazy Express** (commit `4a906d0`, on branch `worktree-agent-a4f0c0567113ff524`, NOT merged): makes `RestServer`'s direct `import express` lazy (deferred `ensureExpressApp()`, runtime-resolved). `pnpm verify` was green in its isolated worktree; Node Express path unchanged. **Salvage this as the base for the work below** — but note it is incomplete (the worker still failed the doctor afterward).

## The remaining edge-hostile transitive graph (the real work)

Empirically, after lazy-Express + edge-safe-dotenv, a real `RestApplication` worker STILL pulls (verified via `esbuild --external:node:*`):

| Dep | Pulled by | Node-only via |
|---|---|---|
| `multer` → `busboy` | rest's upload/multipart handling (multer is a direct `@agentback/rest` dep) | bare `stream`, disk storage → `fs` |
| `cookie-signature` | Express (cookie handling) | `crypto` |
| `etag` | Express (response/static) | `crypto` |
| `send` / `serve-static` (likely) | Express static/file responses | `fs` |
| a residual `node:fs` | (trace to its importer — likely multer disk storage or `serveStaticDir` reachable via an install\* path) | `fs` |

The lesson: the headline dep (Express) is lazy in two edits, but the **transitive tail** (multer, etag, cookie-signature, send) is the bulk of the work, and the estimate from the direct imports undercounts it.

## Approach

1. **Full transitive audit:** bundle the fixture worker with `esbuild --external:node:*` and walk the failures + `metafile.inputs[*].imports` to enumerate EVERY edge-hostile reachable module and its importer. Do not estimate from direct imports.
2. **Lazy-load / make-optional, dep by dep**, using the proven pattern (`process.getBuiltinModule` + `createRequire` inside a Node-guarded lazy initializer; type-only imports stay):
   - `multer`/uploads → load only when an upload route is actually registered (uploads are already a first-class-but-opt-in feature). Keep it off the fetch-only static graph.
   - Express response helpers (etag, send, cookie) → these come with Express; once `RestServer` is fully Express-lazy (B1 base), confirm they're gone. If any are reached independently, isolate them.
   - The residual `node:fs` → trace the importer; if it's `serveStaticDir`/`asset-source-disk` reached via an install\* helper, ensure the fetch-only path doesn't import it.
3. **Acceptance:** the real `RestApplication` fixture worker passes the accurate bundle doctor (`{ok:true}`), AND a real `wrangler deploy` of it serves `/openapi.json` 200 (the credential-gated e2e from Phase 2a, now able to use the RestApplication fixture instead of the `createFetchHost` stand-in).
4. **Regression guard at every step:** full `pnpm verify` (2278+ tests) green; Node Express/upload/cookie behavior identical. This is core-framework surgery — treat it with the same rigor as B1/B2.

## Risks / open questions

- May require making some currently-eager features (multer uploads, certain Express middleware) opt-in/lazy in a way that subtly changes Node ergonomics — surface any such change.
- Some Express transitive deps may have no clean lazy boundary; if so, the question becomes whether the **core REST request path** can be made Express-independent (it already is for `fetchHandler()` logic; the coupling is packaging) or whether an edge build needs a distinct, slimmer host assembly.
- Scope this properly (own spec → plan) before implementing; the Phase 2a estimate was wrong by counting only direct imports.
