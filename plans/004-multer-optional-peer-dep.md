# Plan 004 — Make `multer` an optional peer dependency of `@agentback/rest`

**Written against commit:** `528cec6` (verify with `git rev-parse --short HEAD`).
**Package(s):** `@agentback/rest`.
**Effort:** S/M.
**Status:** TODO.
**Depends on:** nothing (independent of Plan 005).

---

## Why this exists

`multer` is a hard `dependency` of `@agentback/rest` (`packages/rest/package.json:41`, `"multer": "^2.2.0"`), but it is used in exactly ONE place: `makeMultipartMiddleware()` (`packages/rest/src/multipart.ts:109`), the **Express-path** multipart parser, via the lazy `loadMulter()` (`multipart.ts:24-33`, `createRequire('multer')`). The runtime-neutral / `listener: 'native'` path does NOT use multer at all — it parses multipart with Web `request.formData()` in `parseWebMultipart()` (`packages/rest/src/web/multipart.ts:184`), called from `web/rest-handler.ts:181`.

So every consumer installs multer (+ its `busboy` tree) even if they never declare a `fileField()` upload route, and even if they only deploy to the edge. `CLAUDE.md` already flags this: *"`multer` is currently a direct `rest` dependency — a candidate to optionalize as a peer dep."* This plan does that.

> **Why not a full `MultipartParser` DI port?** Considered and deliberately deferred. The Express/multer middleware and the Web `parseWebMultipart` already ARE the two adapters (different shapes: an Express `RequestHandler` vs an async parser), selected by listener mode. A unifying DI port would let users swap the parser implementation, but there is no demand for that today, and it is more surface than the optional-dep goal needs. If a third parser or user-pluggable parsing is ever wanted, revisit with a `MULTIPART_PARSER` binding key mirroring `FILE_STORE`. For now, peer-dep + a clear error is the right-sized change.

---

## Conventions

- Tests run against built `dist/` — `pnpm build` before `pnpm test`.
- Match the de-facto 3-line copyright header if you touch any file's top (you should not need to).
- `pnpm verify` is the CI mirror; supply-chain age policy applies to lockfile changes (pnpm 11) — see `CLAUDE.md` "pnpm 11 quirks".

## Current state (read first)

`multipart.ts:24-33` — `loadMulter()` already lazy-loads multer and is the only loader:
```ts
function loadMulter(): typeof import('multer') {
  const _process = process as NodeJS.Process & {getBuiltinModule?<T = unknown>(id: string): T};
  const nodeModule = _process.getBuiltinModule!('node:module') as typeof import('node:module');
  const require = nodeModule.createRequire(import.meta.url);
  return require('multer') as typeof import('multer');   // <-- throws an opaque MODULE_NOT_FOUND if multer absent
}
```
`makeMultipartMiddleware()` (`:109-`) calls `loadMulter()({...})` (`:117`). `import type multer from 'multer'` (`multipart.ts:11`) is type-only and stays (no runtime/install footprint).

## The change

1. **`packages/rest/package.json`:** move `multer` out of `dependencies` into `peerDependencies` and mark it optional:
   ```jsonc
   "peerDependencies": { "multer": "^2.2.0" },
   "peerDependenciesMeta": { "multer": { "optional": true } }
   ```
   (Create the `peerDependencies`/`peerDependenciesMeta` blocks if absent. Keep `@types/multer` — if present — wherever the type import needs it; if `@types/multer` is a `dependency`, move it to `devDependencies` since the type import is compile-time only. Verify whether multer ships its own types first: `node -e "console.log(require('multer/package.json').types || require('multer/package.json').typings || 'no own types')"`.)

2. **`multipart.ts` `loadMulter()`:** wrap the `require('multer')` in a try/catch that rethrows an actionable error, so a missing optional dep fails with guidance instead of a raw `ERR_MODULE_NOT_FOUND`:
   ```ts
   try {
     return require('multer') as typeof import('multer');
   } catch {
     throw new Error(
       "@agentback/rest: file uploads require the optional peer dependency 'multer'. " +
         "Install it (`npm i multer`) to use fileField() routes on the Express host, " +
         "or serve via `listener: 'native'`, where multipart is parsed with Web FormData (no multer).",
     );
   }
   ```
   This only fires when an app actually mounts a `fileField()` route on the Express path without multer installed — the failure is now self-explaining.

3. **Workspace install:** multer is still needed at dev/test time (the upload tests + `examples/hello-uploads` exercise it). Because it is now an optional peer dep of `@agentback/rest`, ensure it is still installed in the workspace for tests: add `multer` (and `@types/multer` if it lacks built-in types) to `devDependencies` of the package(s) whose tests/examples use it — at minimum `@agentback/rest` (for `multipart` unit/integration tests) and `examples/hello-uploads`. Run `pnpm install` and confirm `packages/rest/node_modules/multer` resolves.
   - **Why:** peer deps are NOT auto-installed; without a dev/example dep, `pnpm build`/`pnpm test` would hit the new "install multer" error. (This mirrors the esbuild-devDep fix already in this branch's history — a tool a package's tests shell out to must be a declared dep of that package, not relied on via hoisting.)

## Steps

1. Check whether multer ships its own types (command above); decide `@types/multer` placement.
2. Edit `packages/rest/package.json` (peerDependencies + meta + dev/example deps as needed). **Verify:** `pnpm install` succeeds; `packages/rest/node_modules/multer` exists.
3. Edit `loadMulter()` to throw the actionable error. **Verify:** `pnpm build`.
4. Run upload coverage: `pnpm exec vitest run -t upload` and the rest/files suites: `pnpm exec vitest run packages/rest/dist packages/files/dist`. **Verify:** all green (multer still resolves in the workspace).
5. (Optional, recommended) Add a test that `loadMulter`'s error path is actionable — e.g. a unit test that stubs `createRequire` to throw and asserts the thrown message mentions `multer` + `listener: 'native'`. Refactor `loadMulter` minimally if needed to make the require injectable for the test; do not change its production behavior.
6. **Verify:** `pnpm verify` green; the cf-app bundle doctor still `{ok:true}` (`cd packages/cli && node -e "import('./dist/bundle-doctor.js').then(async m=>console.log(JSON.stringify(await m.runBundleDoctor('$(pwd)/fixtures/cf-app/src/index.ts'))))"`).

## Done criteria

- `multer` is in `peerDependencies` + `peerDependenciesMeta.optional`, NOT in `dependencies`, of `@agentback/rest`.
- `pnpm verify` green (multer present at dev/test time via devDeps).
- Mounting a `fileField()` route on the Express host without multer throws the actionable error (test or manual check).
- Bundle doctor still `{ok:true}`.

## Out of scope

- A `MultipartParser` DI port (deferred — see top).
- The Web multipart path (`parseWebMultipart`) — unchanged; it never used multer.
- `@agentback/files` / `FileStore` — unchanged.

## Maintenance note

After this, `@agentback/rest`'s install no longer pulls multer/busboy for non-upload or edge apps. The scaffolder (`create-agentback`) should add `multer` to generated apps that pick an upload-bearing template — check `packages/create-agentback` templates and add multer to the upload template's `package.json` if it isn't already, so scaffolded upload apps work out of the box. (Flag as a follow-up if the template wiring is non-trivial.)

## Escape hatches (STOP and report)

- If moving multer to peerDependencies breaks `pnpm install` under the supply-chain age policy, pin per `CLAUDE.md` guidance and note it — do not downgrade unrelated deps.
- If any upload test fails for a reason OTHER than "multer not installed" (i.e. a real behavior change), STOP — this plan must not alter upload behavior, only the dependency classification + error message.
