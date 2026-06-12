# Context Explorer — Design

**Date:** 2026-05-29
**Status:** Approved, pending implementation plan

## Summary

A `@agentback/context-explorer` package that serves a read-only web UI for
inspecting an application's LoopBack DI container — every binding's key, scope,
type, tags, source, and optional injection metadata, plus the parent-context
chain. The JSON API behind the UI is exposed through a real `@api`-decorated
REST controller registered with `app.restController(...)`, deliberately
dogfooding the framework's own routing decorators (which `mcp-inspector` does
not — it mounts raw express routes). The UI itself is a small **React**
single-page app bundled with **esbuild** and served as a static asset.

## Motivation

The framework already produces the data: `Context.inspect()`
(`packages/context/src/context.ts`) walks the registry and emits a JSON tree of
all bindings plus the parent-context chain. There is no UI to view it. The
existing `mcp-inspector` and `rest-explorer` packages establish the pattern for
small in-process UI packages, but neither exposes its API through the
framework's own REST decorators. This package fills the gap and serves as a
worked example of building an API controller with `@api`/`@get`.

## Design decisions (resolved during brainstorming)

1. **Packaging:** New `@agentback/context-explorer` package, plus wiring
   into `examples/hello-rest` so it is runnable.
2. **UI serving:** JSON API via an `@api` controller; the static UI shell
   mounted with raw express (the `mcp-inspector` pattern). Clean separation
   between the dogfooded API and the static asset delivery.
   2a. **UI stack:** React, bundled with esbuild into a single browser file. This
   diverges from the vanilla-JS approach of `mcp-inspector`/`rest-explorer` and
   introduces a second build step (esbuild) alongside `tsc -b`; the integration
   is handled so `pnpm build` remains the single build command (see "Build
   integration").
3. **Data scope:** Metadata only, read-only. No live value resolution — secret
   bindings (e.g. `JWTBindings.SECRET`) expose only key/scope/tags, never their
   resolved value. Avoids provider side-effects and secret leakage.

## Architecture

### Package layout

```
packages/context-explorer/
  src/
    index.ts                                  # installContextExplorer() + controller + static mount
    __tests__/integration/explorer.integration.ts
    client/                                   # React SPA — bundled by esbuild, NOT by tsc
      main.tsx                                # ReactDOM.createRoot + <App/>
      App.tsx                                 # list + detail + raw-toggle composition
      api.ts                                  # typed fetch wrappers for /bindings and /inspect
      components/
        BindingList.tsx
        BindingDetail.tsx
        RawTree.tsx
  build-client.mjs                            # esbuild bundle script
  package.json
  tsconfig.json                               # server build; EXCLUDES src/client
```

- Added to the root `tsconfig.json` project references after `rest`, alongside
  the other UI packages (`rest-explorer`, `mcp-inspector`).
- `package.json` is `@agentback/context-explorer`, ESM-only, emitting to
  its own `dist/`, with workspace deps on `@agentback/rest`,
  `@agentback/openapi`, `@agentback/core`, `@agentback/context`,
  `zod`, and `express`; plus `react` + `react-dom` as runtime deps and
  `esbuild`, `@types/react`, `@types/react-dom` as devDeps.
- `src/client/` is **excluded** from the package `tsconfig.json` so `tsc` never
  sees the TSX/DOM code — esbuild owns the client. The server-side `index.ts`
  builds normally via project references.
- `pnpm install` after creation to wire workspace symlinks.

### The API — `ContextExplorerController`

A controller built with the framework's own decorators, registered by
`installContextExplorer` via `app.restController(ContextExplorerController)`.

```ts
const InspectQuery = z.object({
  includeInjections: z.coerce.boolean().optional(),
  includeParent: z.coerce.boolean().optional(),
});

@api({basePath: '/context-explorer/api'})
class ContextExplorerController {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE) private app: Context,
  ) {}

  @get('/inspect', {query: InspectQuery, response: ContextInspection})
  async inspect(input: {query: z.infer<typeof InspectQuery>}) {
    return this.app.inspect({
      includeInjections: input.query.includeInjections ?? true,
      includeParent: input.query.includeParent ?? true,
    });
  }

  @get('/bindings', {response: BindingSummaryList})
  async bindings() {
    // Flatten this.app.inspect() into a sortable list of
    // {key, scope, type, tags[], source} summaries.
  }
}
```

- **Why `@inject(CoreBindings.APPLICATION_INSTANCE)` and not `@inject.context()`:**
  the controller may be resolved in a request-scoped child context during
  dispatch; the `Application` instance is the root `Context` and gives the full
  registry plus the complete parent chain.
- **`ContextInspection`** is a permissive Zod schema wrapping the recursive
  `inspect()` JSON (the LB dump is recursive and not worth fully typing). It
  satisfies the `response:` contract and emits into `/openapi.json` without
  attempting an exact shape. Concretely: a passthrough object schema (e.g.
  `z.looseObject({name: z.string(), bindings: z.record(z.string(), z.any())})`
  with an optional recursive `parent`), permissive enough to never reject a real
  dump.
- **`BindingSummaryList`** is `z.array(BindingSummary)` where `BindingSummary`
  is `{key, scope, type, tags: string[], source?}` — the flattened, sortable
  view the UI list consumes.
- **Two endpoints by design:** `/bindings` is the flat summary for the list
  view; `/inspect` is the full nested tree (including the parent chain) for the
  detail/raw view.
- **Metadata only.** No resolve endpoint.

### The UI — React SPA served via express

`installContextExplorer(app, options?)`:

1. Registers `ContextExplorerController` on the app.
2. Mounts, via `restServer.expressApp`:
   - `GET options.path` (default `/context-explorer`) → a tiny server-rendered
     HTML shell string. The shell contains only `<div id="root"></div>` and a
     `<script src=".../main.js">` tag — **no user data is interpolated**, so it
     stays XSS-safe by construction (the React tree renders client-side from the
     API, and React escapes by default).
   - `express.static` over the esbuild output dir (`dist/client/`) at
     `options.path + '/assets'`, serving `main.js` (and a sourcemap in dev).

Lower-level `mountContextExplorer(restServer, options?)` mirrors
`mountInspector` for callers who resolved the server separately. The
controller registration in the high-level form happens before `app.start()`,
consistent with `installExplorer`/`installInspector`.

The bundle path is resolved relative to `index.js` at runtime
(`new URL('./client/', import.meta.url)`), so it works regardless of CWD.
`installContextExplorer` throws a clear error if the bundle is missing (i.e.
`pnpm build` / `build:client` was not run), pointing the caller at the build
step — no silent fallback.

### Build integration

The client is bundled by **esbuild**, kept entirely separate from the
`tsc -b` project-reference graph:

- `packages/context-explorer/build-client.mjs` runs
  `esbuild.build({entryPoints: ['src/client/main.tsx'], bundle: true,
format: 'esm', target: 'es2022', jsx: 'automatic', outfile: 'dist/client/main.js',
sourcemap: true})`. React + react-dom are bundled in (not externalized) so the
  asset is self-contained.
- The package `package.json` defines `"build:client": "node build-client.mjs"`.
- The **root** `package.json` `build` script changes from `tsc -b` to
  `tsc -b && pnpm -r run build:client`. `pnpm -r run` runs the script only in
  packages that define it (just context-explorer today), so `pnpm build`
  remains the single build command and every other package is unaffected.
- `pnpm clean` also removes `dist/client` (covered by the existing per-package
  `rm -rf dist`).

This preserves the repo invariant that `pnpm build` produces everything under
`dist/` and `pnpm test` runs against `dist/`.

**Options** (mirroring the sibling packages):

```ts
interface ContextExplorerOptions {
  path?: string; // mount path, default '/context-explorer'
  title?: string; // page title, default 'Context Explorer'
}
```

The API base path (`/context-explorer/api`) is fixed by the controller's
`@api({basePath})` for the first version; if `path` is customized the UI still
fetches from the fixed API base. (A later iteration could thread `path` into the
controller, but `@api` basePath is static metadata, so v1 keeps the default.)

### UI layout

Single-page React app, light/dark via `prefers-color-scheme` (CSS in a styled
`<style>` injected by the shell or a co-located CSS string), component-per-pane:

- **`BindingList`** (left): a filterable list of bindings (key text +
  scope/type/tag badges). A controlled text input narrows by key substring;
  clicking a tag badge sets a tag filter. Selection is lifted to `App` state.
- **`BindingDetail`** (right): detail panel for the selected binding — full
  metadata and, when present, its injection list.
- **`RawTree`**: a toggle that renders the full `/inspect` tree (including
  parent chain) as formatted JSON in a `<pre>`.

State lives in `App` via `useState` (selected key, filter text, tag filter, raw
toggle); data is fetched in a `useEffect` on mount. No router, no global store —
the panes are pure functions of `App` state.

Data flow: on mount `api.ts` fetches `/context-explorer/api/bindings` for the
list; selecting a binding renders detail from that summary; toggling raw fetches
`/context-explorer/api/inspect` (lazily, once).

## Example wiring

`examples/hello-rest/src/index.ts`:

- `import {installContextExplorer} from '@agentback/context-explorer';`
- `await installContextExplorer(app);` next to `installExplorer(app, ...)`.
- A console line: `GET ${server.url}/context-explorer/`.

`examples/hello-rest/package.json` gains the workspace dependency.

## Testing

Integration test `packages/context-explorer/src/__tests__/integration/explorer.integration.ts`,
mirroring `rest-explorer`'s `explorer.integration.ts`. Runs against built
`dist/` (project rule: `pnpm build` before `pnpm test`):

1. Boot a `RestApplication`, register a couple of distinctive bindings (varying
   scope and tags), call `installContextExplorer(app)`, `app.start()`.
2. `GET /context-explorer/api/bindings` → 200, JSON array includes the seeded
   keys with correct `scope` and `tags`.
3. `GET /context-explorer/api/inspect` → 200, JSON includes a `bindings` map and
   (default) a `parent` entry, confirming the parent chain is walked.
4. `GET /context-explorer/api/inspect?includeParent=false` → no `parent` key.
5. `GET /context-explorer/` → 200, `text/html`, references the
   `/context-explorer/assets/main.js` bundle and contains `<div id="root">`.
6. `GET /context-explorer/assets/main.js` → 200, JavaScript content type
   (asserts the esbuild bundle was produced and is served — this is why
   `build:client` must run before `pnpm test`).
7. Stop the app in `after`/`finally`.

Because the integration test fetches the bundle, the test depends on
`build:client` having run. The root `pnpm build` now runs it; for a single-file
test run, `pnpm -F @agentback/context-explorer build:client` must precede
`vitest`. This is documented in the package README.

## Out of scope (deliberately)

- Live binding value resolution or any mutation of bindings.
- Live context-event streaming (a later SSE addition could subscribe to
  `bind`/`unbind` events).
- Auth-gating the explorer — that is the caller's middleware concern, same as
  `rest-explorer`/`mcp-inspector`.
- Fully typing the recursive `inspect()` JSON in Zod.

## Note on divergence from siblings

`mcp-inspector` and `rest-explorer` ship zero-build vanilla JS. This package
intentionally uses React + esbuild instead, accepting a second build step and
`react`/`react-dom`/`esbuild` dependencies in exchange for a component-based UI.
The build integration is contained so the repo's `pnpm build` / `dist/`-test
invariants are preserved. If a future cleanup wants UI consistency across the
three packages, this is the odd one out by design, not by accident.

## Addendum — dependency graph view (added post-design, per feedback)

After the initial Browse + Raw views shipped, a third **Graph** view was added
to surface dependency edges (the most useful thing a DI explorer can show).

- **New dogfooded route** `GET /context-explorer/api/graph` on the same
  controller, returning `{nodes, edges}`. `extractGraph()` walks
  `inspect({includeInjections: true})`: every binding is a node; every injection
  (constructor arg or property) whose target is a known binding is an edge
  `from -> to` ("`from` depends on `to`"). Self-edges and edges to unbound keys
  (e.g. optional injections) are dropped.
- **Client**: `GraphView.tsx` renders the graph with **React Flow**
  (`@xyflow/react`, pan/zoom/drag, minimap, controls) laid out left-to-right by
  **dagre** (`@dagrejs/dagre`) — dependencies on the left, dependents on the
  right. Nodes are colored by binding type; selecting a node highlights it and
  its incident edges. The header switches between Browse / Graph / Raw.
- **Build impact**: React Flow's stylesheet is imported in the client, so
  esbuild now also emits `dist/client/main.css`; `mountContextExplorer` links it
  from the shell only when present (`existsSync`). No change to the build
  command — esbuild already owned the client bundle.

## References

- `packages/context/src/context.ts` — `inspect()` / `_inspect()`, the data source.
- `packages/mcp-inspector/src/index.ts` — API + static UI mount pattern (vanilla).
- `packages/rest-explorer/src/index.ts` — `install*`/`mount*` shape and tests.
- `examples/hello-rest/src/index.ts` — example wiring pattern.
