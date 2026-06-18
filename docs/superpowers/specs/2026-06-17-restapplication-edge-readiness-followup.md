# Full `RestApplication` Edge-Readiness — Follow-up Spec (stub)

**Date:** 2026-06-17
**Status:** Backlog — spun off from Phase 2a (Cloudflare Workers)
**Origin:** During Phase 2a implementation, the accurate bundle doctor correctly reported that a real `RestApplication` worker does **not** bundle clean for a Cloudflare Workers isolate. The deploy tooling + doctor shipped; making a real app actually run on the edge is this separate initiative.

---

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
