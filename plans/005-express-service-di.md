# Plan 005 — Introduce `ExpressService`: a DI-owned Express host that `RestServer` injects

**Written against commit:** `528cec6` (verify with `git rev-parse --short HEAD`; if HEAD differs, re-read the cited line ranges before trusting them).
**Package(s):** `@agentback/express`, `@agentback/rest`.
**Effort:** L (core-framework surgery on `RestServer`; high blast radius — gated on full parity).
**Status:** TODO.

---

## Prior art to model this on

`/Users/rfeng/Projects/ninemind/ninemind-faction/goose-slack/packages/express` (`@factionvc/express`) already implements this exact pattern — copy its shape:

- **`src/express.ts`** — `ExpressService`, a class decorated `@lifeCycleObserver('04-express', {scope: BindingScope.SINGLETON, tags: {[ContextTags.KEY]: EXPRESS_SERVICE_KEY}})`, that owns `readonly app: Application` (`= express()`), sets up base middleware in its constructor, and exposes `start()`/`stop()` for the HTTP listener.
- **`src/keys.ts`** — `export const EXPRESS_SERVICE_KEY = BindingKey.create<ExpressService>('services.ExpressService');`
- **`src/component.ts`** — `export class ExpressComponent implements Component { services = [ExpressService]; }`

That is the target structure: a singleton **service class** that owns the Express app, addressable by a **key**, registered by a **component**. Consumers inject the key and use `.app`. This plan brings that pattern into `@agentback/express` and rewires `@agentback/rest`'s `RestServer` to depend on it instead of building Express inline.

> **Note — agentback already has the bones.** `packages/express/src/express.server.ts:42` (`ExpressServer extends BaseMiddlewareRegistry implements Server`) already owns `this.expressApp = express()` with `start()`/`stop()` and is DI-managed. It is the closest existing analogue to the reference `ExpressService` — but `RestServer` does NOT consume it (the only reference is a comment at `rest.server.ts:260`). You may either (a) introduce a new focused `ExpressService` per the reference, or (b) adapt `ExpressServer` into the injectable the reference describes. **Prefer (a)** for a clean, minimal seam unless adapting `ExpressServer` proves simpler after reading it; record which you chose.

---

## Why this exists

`RestServer` (`packages/rest/src/rest.server.ts`) gets the Express runtime through three module-level lazy loaders using `createRequire(import.meta.url)`:

- `loadExpress()` (`:128-131`) → `typeof import('express')` (the `express()` factory + `json`/`urlencoded`/`text`/`raw` parsers).
- `loadExpressHelpers()` (`:140-159`) → `{registerExpressMiddleware, toExpressMiddleware}` from `@agentback/express`.
- `loadCors()` (`:156-159`) → `typeof import('cors')`.

These keep Express off a Cloudflare Worker's static bundle (the session at commit `528cec6` did this) but bypass DI entirely — `RestServer` reaches into the module system instead of depending on an injected service. Costs:

1. `express` + `cors` are hard `dependencies` of `@agentback/rest` (`packages/rest/package.json:39`, `:37`) — installed even by fetch-only / `listener: 'native'` apps.
2. The Express host is not swappable, stubbable, or omittable except via the `createRequire` trick.

The framework already DI-injects the analogous seams: `CoreBindings.FETCH` (`packages/core/src/keys.ts:55`, `{optional: true}`) and the `FILE_STORE` port (`packages/rest/src/multipart.ts:119`). `ExpressService` is the same idea for the Express host.

> **Scope — Phase 1 only.** Deliver the `ExpressService` + key + component, and rewire `RestServer` to consume it, with the default still provided so behavior + bundle are unchanged and parity is provable. Making `express`/`cors` genuinely optional peer deps (off `@agentback/rest`'s hard deps) is **Phase 2**, gated on flipping the default listener to `'native'` (fetch-seam-root-cutover "item D"). Phase 2 is sketched at the end — do NOT attempt it here.

---

## Conventions to follow

- **Binding keys** → `packages/rest/src/keys.ts`, `namespace RestBindings`, `BindingKey.create<T>('rest.<name>')` (mirror `CONFIRMATION_STORE` there). The reference uses `'services.ExpressService'`; in this repo prefer the `rest.` namespace for the binding `RestServer` resolves, i.e. `RestBindings.EXPRESS_SERVICE`.
- **Lifecycle/DI decorators** — confirm `@agentback/core` exports `lifeCycleObserver`, `BindingScope`, `config`, `ContextTags`, `Component` (it is the LB4 fork; the reference imports these from `@loopback/core`). If a name differs, use the `@agentback/core` equivalent and note it.
- **Copyright header** — the repo's de-facto 3-line header (NOT the stale `CLAUDE.md` spec, and NOT the reference's Faction header):
  ```ts
  // Copyright ninemind.ai 2026. All Rights Reserved.
  // This file is licensed under the MIT License.
  // License text available at https://opensource.org/license/mit/
  ```
- **ESM** `.js` on relative imports. **Tests run against built `dist/`** — `pnpm build` before `pnpm test`.
- **Edge discipline (critical):** `RestServer` must import only the binding KEY and a TYPE — never the `ExpressService` class or the `@agentback/express` barrel — or Express returns to the edge static graph. Import the type from a **subpath** (`@agentback/express/express-service`), the way `keys.ts`/`rest.application.ts` already import express bits via subpaths at commit `528cec6`.

---

## Current state (read before changing)

- The three loaders: `rest.server.ts:128-159`.
- Consumers: `ensureExpressApp()` (`:249-271`), `registerBuiltinMiddleware()` (`:284-319`), `registerBodyParser()` (`:327-`).
- `ensureExpressApp()` builds the app: `this._app = expressLib()` (`:253`), then `registerBuiltinMiddleware()` + mounts the LB chain via `toExpressMiddleware` (`:268`).
- Constructor injection point: `:213-239` (`@inject(CoreBindings.APPLICATION_INSTANCE) context`, `@config() cfg`).
- Native/fetch path never calls `ensureExpressApp()` — `start()` gates Express mounting on `this.listenerMode !== 'native'`, and `fetchHandler()` never touches it. **Preserve this.**
- Reference `ExpressService`: `goose-slack/packages/express/src/{express,keys,component}.ts` (read all three).

---

## Design

### In `@agentback/express`

`packages/express/src/express-service.ts` — the service class, modeled on the reference but carrying what `RestServer` needs (the app, plus the runtime bits RestServer registers middleware/parsers with):

```ts
// Copyright ninemind.ai 2026. ... (3-line header)
import {BindingScope, ContextTags, lifeCycleObserver} from '@agentback/core';
import express, {type Express} from 'express';
import cors from 'cors';
import {registerExpressMiddleware, toExpressMiddleware} from './middleware.js';
import {EXPRESS_SERVICE_KEY} from './express-service-keys.js';

/**
 * DI-owned Express host. Singleton service holding the Express `app` and the
 * runtime helpers RestServer needs to mount routes + the LB middleware chain.
 * Registered via ExpressComponent; absent on edge/native apps (which never
 * resolve it), so it never enters a Worker bundle.
 */
@lifeCycleObserver('express', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: EXPRESS_SERVICE_KEY},
})
export class ExpressService {
  readonly app: Express = express();
  // Expose the runtime pieces RestServer currently pulls via its loaders:
  readonly express = express;          // factory + json/urlencoded/text/raw
  readonly cors = cors;
  readonly registerExpressMiddleware = registerExpressMiddleware;
  readonly toExpressMiddleware = toExpressMiddleware;
}
```
Plus `EXPRESS_SERVICE_KEY` in a small `express-service-keys.ts` (so the key has no static dep on the class — the class imports the key, mirroring the reference), and `ExpressComponent` (`{ services = [ExpressService] }`) in `express-component.ts`. Export all three from the barrel `index.ts`, and add `./express-service`, `./express-service-keys`, `./express-component` to `packages/express/package.json` `exports`.

> Decide while implementing: should `ExpressService` own the **listener** (`start()`/`stop()`, like the reference) or keep that in `RestServer`? For Phase 1, **keep the listener in `RestServer`** (it already `implements Server` and owns `start()/stop()`) — `ExpressService` just owns the `app` + runtime helpers. Moving the listener is a larger change; defer it.

### In `@agentback/rest`

- `keys.ts`: `export const EXPRESS_SERVICE = BindingKey.create<ExpressService>('rest.expressService');` with `import type {ExpressService} from '@agentback/express/express-service';` (subpath — NOT the barrel).
- `RestServer` constructor: add `@inject(RestBindings.EXPRESS_SERVICE, {optional: true}) private injectedExpressService?: ExpressService`.
- A private `expressService(): ExpressService` accessor: returns the injected one if present, else the Phase-1 default assembled from the existing `loadExpress()`/`loadCors()`/`loadExpressHelpers()` (memoized). This is the ONLY place the loaders are called.
- `ensureExpressApp()` uses `this.expressService().app` instead of `expressLib()`; `registerBuiltinMiddleware()`/`registerBodyParser()` use `this.expressService().{express,cors,registerExpressMiddleware,toExpressMiddleware}`.

Phase 1 stays parity-preserving: with no `EXPRESS_SERVICE` bound, the default path is byte-equivalent to today; the seam is purely additive.

---

## Steps (ordered; each ends with verification)

1. **Read the reference** (`goose-slack/packages/express/src/{express,keys,component}.ts`) and confirm `@agentback/core` exports `lifeCycleObserver`, `BindingScope`, `ContextTags`, `Component` (`grep -rn "export" packages/core/src/index.ts | grep -iE "lifeCycleObserver|BindingScope|ContextTags|Component"`). If any name differs, record the agentback equivalent. **Verify:** names resolved.
2. **Create `express-service-keys.ts`, `express-service.ts`, `express-component.ts`** in `@agentback/express`; export from `index.ts`; add the three subpath `exports`. **Verify:** `pnpm -F @agentback/express build`.
3. **Add `RestBindings.EXPRESS_SERVICE`** to `rest/src/keys.ts` (subpath `import type`). **Verify:** `pnpm -F @agentback/rest build`.
4. **Inject + accessor** in `RestServer` (constructor param + `expressService()` accessor that falls back to the loaders). **Verify:** `pnpm -F @agentback/rest build`.
5. **Route the call sites** (`ensureExpressApp`/`registerBuiltinMiddleware`/`registerBodyParser`) through `this.expressService()`; keep the loader functions (the default uses them). **Verify:** `pnpm build && pnpm exec vitest run packages/rest/dist` — full rest suite green (parity gate).
6. **Test the seam** (new file under `packages/rest/src/__tests__/`, styled after `native-listener.integration.ts`): (a) default Express-mode app starts + serves with nothing bound; (b) binding a stub `EXPRESS_SERVICE` makes `RestServer` use it (spy the stub's `express`/`app`). **Verify:** new test passes.
7. **Optional but recommended — register via component on the Node path.** If `RestApplication` should auto-wire it, do so through the existing lazy/Node boundary so the class is NOT statically imported by the edge graph. If unsure, SKIP (Phase 1 default accessor already covers Node). **Verify:** bundle doctor (step 8) still `{ok:true}`.
8. **Edge bundle unchanged.** `cd packages/cli && node -e "import('./dist/bundle-doctor.js').then(async m=>console.log(JSON.stringify(await m.runBundleDoctor('$(pwd)/fixtures/cf-app/src/index.ts'))))"` → must be `{"ok":true,"message":""}`. **Verify + full `pnpm verify`.**

---

## Done criteria (machine-checkable)

- `pnpm verify` green.
- Bundle doctor on `packages/cli/fixtures/cf-app` → `{ok:true}`.
- `grep -n "loadExpress\|loadCors\|loadExpressHelpers" packages/rest/src/rest.server.ts` → the loaders are called from exactly one place (the `expressService()` accessor).
- A test binds a stub `EXPRESS_SERVICE` and asserts `RestServer` uses it.

## Out of scope (do NOT touch)

- The fetch/native path (`fetchHandler`, `collectRoutes`, `web/*`).
- Removing `express`/`cors` from `@agentback/rest` deps (Phase 2).
- Moving the HTTP listener into `ExpressService` (defer).
- multer/uploads (Plan 004).

## Test plan

New seam test (default + injected-stub). Regression: the entire `@agentback/rest` suite (Express dispatch, middleware order, body parsing, CORS, framework routes) must pass unchanged; `native-listener.integration.ts` stays green.

## Maintenance note

`expressService()` is the single chokepoint for "how `RestServer` gets Express." Watch in review that no `loadExpress()`/`loadCors()` call reappears outside it, and that `keys.ts` imports the `ExpressService` type from the `@agentback/express/express-service` **subpath**, never the barrel.

## Escape hatches (STOP and report)

- Any existing test changes behavior after step 5 → the default provider is not byte-equivalent; report the diff.
- Bundle doctor flips to `{ok:false}` → Express re-entered the static graph (likely a barrel import or the component being statically imported by the edge graph); fix the import, do NOT re-add `createRequire` indirection elsewhere.
- `@agentback/core` lacks `lifeCycleObserver`/`ContextTags` (fork diverged from LB4) → STOP; the service-class decoration may need a different registration (plain `@injectable`/`app.service`); report before improvising.

## Phase 2 (gated follow-up — NOT this plan)

After the default listener flips to `'native'` (item D): register `ExpressService` only via `ExpressComponent` on opt-in Node apps, drop `express`/`cors` from `@agentback/rest` deps (→ provided by `@agentback/express` / peer dep), and have `RestServer` throw a clear "Express host not registered — add ExpressComponent or use listener:'native'" when an Express-mode app has no `EXPRESS_SERVICE`. Delivers genuinely optional Express at install time.
