# Fetch Adapter Seam — Stage 1 Part 3 (Additive Fetch surface) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Wire the route registry into the core `Router`, expose an app-level **fetch handler** (`RestServer.fetchHandler()`) built from `Router` + `RestHandler` + `createFetchHost`, give `createTestApp` an in-process `fetch` client, and prove Express↔Fetch parity for real `@api` controllers. The live Express request path is **untouched** — auth/hooks/idempotency/streaming stay on it. This is the **additive Fetch surface** (not the full Express demotion).

**Architecture:** `collectRoutes(context, basePath)` scans controller specs (the same discovery `RestServer.controller()` uses) and produces `RouteRecord<RouteValue>[]`; `RestServer.fetchHandler()` lazily builds a `Router` from them + a `RestHandler` over the app context. Part 1/2 modules get **exported** now (the validated surface). `createTestApp` exposes `fetch()` driving that handler with no socket.

**Tech Stack:** TypeScript ESM, `@agentback/openapi` (`getControllerSpec`, `lookupRouteSchemas`), `@agentback/context`, vitest, `@agentback/testing`.

> **Reference:** spec `…fetch-adapter-seam-design.md` ("Stage 1 Part 3" follow-up rows). Part 1 shipped plumbing; Part 2 shipped `RestHandler` core (internal). This part is where the seam goes **public**.

> **Build rule:** vitest runs against `dist/` — `pnpm -F @agentback/rest build` before every `pnpm exec vitest run`.

> **Out of scope (later):** full Express demotion / non-greedy fallback; porting auth/authz, dispatch hooks, confirmation/idempotency, streaming to the Web pipeline (these stay Express-only until a dedicated effort); uploads (Stage 3); neutralizing `install*` UIs.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/rest/src/route-meta.ts` | Extracted `lookupSuccessStatus(ctor, methodName)` (currently module-private in `rest.server.ts`) — shared by the Express mount path and `collectRoutes`. |
| `packages/rest/src/web/collect-routes.ts` | `collectRoutes(context, basePath?)` → `RouteRecord<RouteValue>[]` from controller specs. |
| `packages/rest/src/rest.server.ts` | MODIFY: import `lookupSuccessStatus` from `route-meta.js`; add `fetchHandler(): FetchHost` (lazy). |
| `packages/rest/src/index.ts` | MODIFY: export the now-validated `web/`+`host/` surface. |
| `packages/rest/src/__tests__/integration/fetch-handler.integration.ts` | Build a `RestApplication`, drive both Express (supertest) and `fetchHandler()` → parity for multiple controllers/routes. |
| `packages/testing/src/*` (createTestApp) | MODIFY: add `fetch(input, init?)` to the returned harness. |
| `packages/testing/src/__tests__/*` | A createTestApp-level parity/fetch test. |

---

## Task 1: Extract `lookupSuccessStatus` into `route-meta.ts`

**Files:** Create `packages/rest/src/route-meta.ts`; Modify `rest.server.ts`.

- [ ] **Step 1:** Create `packages/rest/src/route-meta.ts` with the 3-line header and the `lookupSuccessStatus` function moved verbatim from `rest.server.ts` (find it with `grep -n "function lookupSuccessStatus" packages/rest/src/rest.server.ts`). It imports `getControllerSpec` from `@agentback/openapi`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {getControllerSpec} from '@agentback/openapi';

/**
 * Re-derive a route's success status (200 default; 201/204/… from `status:`)
 * from the controller's OpenAPI spec. Shared by the Express mount path and the
 * Web `collectRoutes` so both agree on status without re-walking metadata.
 */
export function lookupSuccessStatus(ctor: Function, methodName: string): number {
  // ... (move the existing body verbatim)
}
```

- [ ] **Step 2:** In `rest.server.ts`, DELETE the local `function lookupSuccessStatus` and add `import {lookupSuccessStatus} from './route-meta.js';`. Leave its call site (in `makeHandler`) unchanged.

- [ ] **Step 3:** `pnpm -F @agentback/rest build && pnpm exec vitest run packages/rest/dist` — full suite green (behavior-preserving).

- [ ] **Step 4:** Commit — `refactor(rest): extract lookupSuccessStatus into route-meta`.

---

## Task 2: `collectRoutes`

**Files:** Create `packages/rest/src/web/collect-routes.ts`.

- [ ] **Step 1: Implement** (mirrors `RestServer.controller()`'s discovery; produces `{name}`-template records the core `Router` consumes directly):

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {CoreTags} from '@agentback/core';
import {getControllerSpec, lookupRouteSchemas} from '@agentback/openapi';
import {lookupSuccessStatus} from '../route-meta.js';
import type {RouteRecord} from './router.js';
import type {RouteValue} from './route-value.js';

/**
 * Build the core Router's route records from the controllers bound in `context`
 * — the same discovery `RestServer.controller()` does for Express, but emitting
 * the OpenAPI `{name}` path template the core Router matches natively (no
 * `:name` translation). `basePath` mirrors the RestServer config prefix.
 */
export function collectRoutes(
  context: Context,
  basePath = '',
): RouteRecord<RouteValue>[] {
  const records: RouteRecord<RouteValue>[] = [];
  for (const binding of context.findByTag(CoreTags.CONTROLLER)) {
    const ctor = binding.valueConstructor;
    if (typeof ctor !== 'function') continue;
    const spec = getControllerSpec(ctor);
    const prefix = basePath + (spec.basePath ?? '');
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [verb, operation] of Object.entries(
        item as Record<string, unknown>,
      )) {
        if (!operation || typeof operation !== 'object') continue;
        const methodName = (operation as {operationId: string}).operationId
          .split('.')
          .pop()!;
        const schemas = lookupRouteSchemas(ctor.prototype, methodName) ?? {};
        records.push({
          method: verb.toUpperCase(),
          template: prefix + path,
          value: {
            ctor,
            methodName,
            schemas,
            successStatus: lookupSuccessStatus(ctor, methodName),
          },
        });
      }
    }
  }
  return records;
}
```

- [ ] **Step 2:** Build. (Tested via Task 4's parity test, which depends on the handler from Task 3.) Commit with Task 3.

---

## Task 3: `RestServer.fetchHandler()`

**Files:** Modify `packages/rest/src/rest.server.ts`.

- [ ] **Step 1:** Add imports near the other relative imports:
```ts
import {collectRoutes} from './web/collect-routes.js';
import {Router} from './web/router.js';
import {RestHandler} from './web/rest-handler.js';
import {createFetchHost, type FetchHost} from './host/fetch.js';
import type {RouteValue} from './web/route-value.js';
```

- [ ] **Step 2:** Add a lazily-built handler (place near `expressApp` getter):
```ts
  private _fetchHost?: FetchHost;

  /**
   * The runtime-neutral fetch handler for this app's `@api` routes — the same
   * routing + Zod validation + DI + error-envelope pipeline as the Express
   * path (via {@link RestHandler}), exposed as `fetch(Request): Promise<Response>`
   * for Web-standard hosts (`Bun.serve`, `Deno.serve`, Workers, tests).
   *
   * Additive: the Express server is unchanged. Auth, dispatch hooks,
   * confirmation/idempotency, and streaming are NOT yet in this path — they
   * remain Express-only until ported. Built lazily from the route registry on
   * first call (controllers must be registered by then; call after `start()`
   * or after all `controller()` calls).
   */
  fetchHandler(): FetchHost {
    if (!this._fetchHost) {
      const router = new Router<RouteValue>();
      for (const record of collectRoutes(this.context, this.config.basePath ?? '')) {
        router.add(record);
      }
      const handler = new RestHandler(this.context);
      this._fetchHost = createFetchHost({router, dispatch: handler.dispatch});
    }
    return this._fetchHost;
  }
```
(If `this.config.basePath` isn't the right field name, grep the config type and use the actual one — match what `controller()` uses for its prefix.)

- [ ] **Step 3:** Build. Commit Tasks 2+3 — `feat(rest): RestServer.fetchHandler() — registry-driven Web surface`.

---

## Task 4: Express↔Fetch parity over the registry

**Files:** Create `packages/rest/src/__tests__/integration/fetch-handler.integration.ts`.

- [ ] **Step 1:** Boot a `RestApplication` with 1–2 `@api` controllers (a couple routes incl. a path param, a `status:201`, a validation-fail, an `AgentError`). Start it (supertest drives Express). Get `restServer.fetchHandler()`. For each route, hit Express (supertest) and the fetch handler (`new Request`) and assert equal status + body — same approach as `web-parity.integration.ts` but routed through the REGISTRY (not hand-built `RouteValue`s), proving `collectRoutes` produces the right templates/schemas/status.
- [ ] **Step 2:** Include a route under a controller `basePath` to prove the prefix is applied. Include a 404 (unmatched path) → assert the fetch handler's nested `{error:{code:'not_found'}}` envelope.
- [ ] **Step 3:** Build + run. If `collectRoutes` mis-derives a template/status, fix `collect-routes.ts` (the test is the arbiter). Commit — `test(rest): Express<->Fetch parity via the route registry`.

---

## Task 5: Export the seam + `createTestApp.fetch()`

**Files:** Modify `packages/rest/src/index.ts`; modify `@agentback/testing`'s createTestApp.

- [ ] **Step 1 (export the seam — lifts the Part 1/2 D5 hold):** Add to `index.ts`, matching the `export *` barrel style:
```ts
export * from './web/router.js';
export * from './web/dispatch.js';
export * from './web/route-value.js';
export * from './web/rest-handler.js';
export * from './web/collect-routes.js';
export * from './host/fetch.js';
export * from './host/node.js';
```

- [ ] **Step 2 (testing harness):** READ `packages/testing/src/` to find where `createTestApp` builds its return object (`{app, url, client, http, mcp, call, stop}`). Add a `fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>` that lazily gets the RestServer's `fetchHandler()` and calls `host.fetch(new Request(new URL(input, url), init))` (resolve relative paths against the booted app's `url`). Update the harness's return type/interface accordingly. Document it in `packages/testing/README.md` (one line next to `http`/`client`).

- [ ] **Step 3 (testing parity test):** In `@agentback/testing`'s tests, add a small test that boots an app via `createTestApp`, calls `await app.fetch('/some/route')`, and asserts the Web `Response` — and ideally cross-checks against the supertest `http` client for the same route (createTestApp can use the testing→rest dependency freely; the circular constraint only bit the reverse direction).

- [ ] **Step 4:** `pnpm -F @agentback/testing build && pnpm exec vitest run packages/testing/dist`. Then full `pnpm build && pnpm test`. Commit — `feat(rest,testing): export Fetch seam + createTestApp.fetch() client`.

---

## Task 6: Guard + docs

- [ ] **Step 1:** `pnpm verify` (build + typecheck:client + test + validate-templates) — the whole CI mirror, since `index.ts` exports changed (public API) and `testing` changed.
- [ ] **Step 2:** `pnpm lint` — fix new-file issues.
- [ ] **Step 3:** Update the spec's "Known limitations" / status: the seam is now exported and registry-wired; mark Part 3 (additive surface) done, full Express demotion still pending. Commit docs.

---

## Self-Review

- **Spec coverage:** registry→Router (`collectRoutes`), app fetch handler (`fetchHandler()`), `createTestApp.fetch` client, Express↔Fetch parity harness — all present. Full Express demotion + auth/hooks/idempotency/streaming explicitly out of scope (additive surface, per the chosen fork).
- **DRY:** `lookupSuccessStatus` extracted and shared (Task 1); `collectRoutes` mirrors `controller()` discovery rather than forking metadata reads; `RestHandler`/`parseSection`/`buildErrorEnvelope` reused.
- **Parity is the arbiter:** Task 4 proves the registry-derived routes match Express byte-for-byte; Task 5's testing test proves the public `fetch()` client works end-to-end.
- **Export discipline:** the seam goes public only now (Part 3), after Parts 1–2 proved it internally.
- **No live-path risk:** the Express dispatch is untouched; `fetchHandler()` is additive and lazy.
