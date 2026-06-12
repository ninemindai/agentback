# Composable Admin Console — Design

**Status:** Draft · **Date:** 2026-05-30

## Goal

Unify the three existing developer UIs — `context-explorer`, `rest-explorer`
(Swagger), and `mcp-inspector` — under one cohesive admin console, shipped as a
**reusable package** with a small **extension-point contract** so any package
can contribute a panel. Today each tool is an independent SPA with its own HTML
shell, its own esbuild bundle, and its own copy of the theme; there is no shared
chrome, navigation, or theme.

Prior art: an earlier admin-console — a single React SPA
with a two-sided extension point (build-time client pages + runtime server
routes), nav derived from a page list, a semantic token theme, mounted into the
shared Express app, with the server as the auth authority. This design is a
faithful, smaller adaptation to this repo's esbuild + pnpm-workspace reality.

## Key decisions

1. **Reusable package + extension-point contract** (not a one-off, not iframes).
   A new `@agentback/console` exposes `ConsolePage` / `ConsoleFeature`
   contracts; the three tools become contributors.
2. **Explicit static registration** (not build-time auto-discovery, not runtime
   federation). The console composes panels by explicit import — no codegen, no
   virtual modules, no dynamic loader. Adding a panel = add a dependency + one
   import line. Rationale: the source runtime's auto-discovery is a Vite-plugin nicety we
   don't need; explicit composition matches this repo's "keep it small, no
   manager layer" ethos while keeping the _contract_ reusable (anyone can author
   a `ConsolePage`).

## Architecture

Two explicit lists mirror the source runtime's two-sided model:

- **Client (build-time):** each tool exports `pages: ConsolePage[]` from a
  `./console` subpath. The console's `src/pages.ts` imports them explicitly and
  concatenates; esbuild emits **one** SPA bundle.
- **Server (runtime):** each tool exports a `ConsoleFeature` that registers its
  API controller into DI. `installConsole(app, …)` calls each feature's
  `install`, so every panel's API is mounted; tools still work standalone.

### Contracts (in `@agentback/console`)

```ts
// Client: a panel in the shell. Rendered with its apiBase.
interface ConsolePage {
  id: string;
  title: string;
  icon?: string; // small glyph; pages without icon+order are deep-link-only
  order: number; // sidebar sort, 10-spacing (10/20/30…) for insertion
  route: string; // client route under basePath, e.g. '/context'
  component: ComponentType<{apiBase: string}>;
}

// Server: registers the panel's API controller(s) into the app.
interface ConsoleFeature {
  id: string; // must match a ConsolePage id
  install(app: RestApplication): Promise<void> | void;
}
```

### Package layout

```
packages/console/
  src/index.ts          installConsole(app, opts) + ConsolePage/ConsoleFeature types
  src/pages.ts          explicit import of each tool's pages  ← edit to add a panel
  src/client/
    main.tsx            reads window.__CONSOLE__, renders <App>
    App.tsx             router + shell
    Shell.tsx           header + sidebar (nav derived from pages) + content pane
  build-client.mjs      esbuild → dist/client/main.js (one bundle)
  tsconfig.json
  package.json          exports '.'; depends on the three tools + console-theme
packages/console-theme/
  src/index.ts          exports the shared theme CSS string + token names
```

### Shell

React app at `basePath` (default `/console`): a header (console title + active
panel title) + left sidebar (nav derived from `pages`, sorted by `order`,
icon-less pages omitted from nav) + a content pane that renders the active
page's `component` with its `apiBase`. Client-side routing under `basePath`.

## Contributor refactors

Each tool keeps its standalone `installX` **unchanged** and adds two exports:
`pages` (client, via `./console`) and `consoleFeature` (server).

The one real refactor is **config flow**. Today each client reads a module-load
global (`window.__CTX_EXPLORER__`, `window.__MCP_INSPECTOR__`); in a single
bundle with multiple panels that can't work. Each tool's client is changed to
take `apiBase` (and the inspector's `connect`) as input:

- **API module → factory.** `mcp-inspector` already has `localApi()/remoteApi(id)`
  factories. `context-explorer`'s `api.ts` uses a module global → refactor to
  `makeApi(apiBase)`. The panel supplies the api to children via a small context
  (the inspector already has `ApiContext`).
- **`App` takes props.** Extract each root into `App({apiBase, connect?})`. The
  existing `main.tsx` (standalone) reads its global and renders
  `<App apiBase={cfg.apiBase}/>` — behavior unchanged. The new `console-page.tsx`
  exports `pages` whose `component` is that same `App`.
- **Server `consoleFeature`.** e.g. context-explorer's `install(app)` does
  `app.restController(ContextExplorerController)`; mcp's also wires mcp-connect
  when remote mode is enabled; rest-explorer's calls `installExplorer(app)`.
- **Panel chrome.** Each tool's existing top `<header>` (filter, history button,
  the inspector's Server dropdown) becomes the **panel's own toolbar** inside the
  content pane — no rework. The shell supplies the outer chrome.

### `rest-explorer` (Swagger) — the exception

Swagger UI is third-party, not our React and not a JSON API. v1 slots it in as
an **iframe panel**: `rest-explorer` exports a `SwaggerPanel` that renders
`<iframe src="/explorer">`, and its `consoleFeature.install` mounts `/explorer`

- `/openapi.json` as today. Isolated, zero rework. Future upgrades (not v1):
  `swagger-ui-react` (no iframe) or a native themed OpenAPI viewer.

## Theme — one source of truth

The newspaper theme (the `--paper/--ink/--accent/…` tokens, base element styles,
and the shared `.card/.btn/.field/.badge/pre.json` widget classes) is currently
copy-pasted into `context-explorer`'s `EXPLORER_CSS` and `mcp-inspector`'s
`INSPECTOR_CSS`. Extract the common core into **`@agentback/console-theme`**
(a CSS string + token names):

- The console shell injects it once; every panel renders correctly because the
  tool components already style via those CSS variables.
- Each tool's standalone `mountX` imports the same theme instead of its inlined
  copy → de-duplicated (~120 lines of tokens/base removed).
- Tool-_specific_ CSS (context-explorer's graph styles; the inspector's
  `.connectbar` and history panel) stays local to each tool, appended after the
  shared core.

## Server: `installConsole`

```ts
interface ConsoleOptions {
  basePath?: string; // default '/console'
  title?: string; // default 'AgentBack console'
  features?: ConsoleFeature[]; // default: [context, api, mcp]
  auth?: RequestHandler | RequestHandler[]; // optional gate; default none
}
async function installConsole(
  app: RestApplication,
  opts?: ConsoleOptions,
): Promise<void>;
```

Flow:

1. For each `feature`, call `feature.install(app)` (registers that tool's API
   controller; `installExplorer` for Swagger).
2. `await app.restServer`; if `auth` is set, mount it in front of `basePath` and
   the aggregated APIs.
3. Serve the console bundle at `<basePath>/assets` and the shell HTML +
   `window.__CONSOLE__` at `<basePath>` and `<basePath>/`.

**API bases (v1):** keep each tool's _existing_ base (`/context-explorer/api`,
`/mcp-inspector/api`, `/explorer`); the injected `window.__CONSOLE__` config maps
each panel → its base. No controller re-basing under `/console/api/*` (a tidy-up
deferred to a later iteration). `feature.install` registers **only** the
controller — not a shell — so the console never double-mounts a tool's shell.

**Config injection:** one `window.__CONSOLE__ = {basePath, title, pages: [{id,
route, title, icon, order, apiBase, extra?}]}`. The shell reads it for
nav/routing and passes each panel its `apiBase`. The `ConsolePage.component`
contract stays minimal (`{apiBase}`); a panel needing extra config reads its own
`pages[id].extra` from `window.__CONSOLE__` — e.g. the mcp-inspector panel reads
its `connect` (remote-connect base + OAuth callback) and the Swagger panel reads
its `/explorer` URL from `extra`. This keeps the contract uniform while letting
specific panels carry their own settings.

## Security

The console aggregates sensitive surfaces:

- `context-explorer` exposes DI container internals (bindings, sources, tags).
- `mcp-inspector` + `mcp-connect` can trigger **outbound** connections (SSRF
  surface — see the mcp-connect SSRF guard) and invoke tools on connected
  remote servers.

Therefore: `installConsole`'s `auth` option lets callers gate the whole console
(and the aggregated APIs) behind their app's auth middleware. The default is
none (matching the explorers today), but production deployments **should** set
it. The server is the authority; client-side nav hiding is cosmetic only. This
mirrors a "server is the authority" discipline.

## Build

- Console `build-client.mjs` (esbuild, same as the other UI packages) bundles
  `src/client/main.tsx` → `src/pages.ts`. esbuild reaches into each tool's
  `./console` **source TSX** (the `exports` map points at the source), so tools
  need no pre-built client for the console bundle.
- The server `index.ts` (tsc) imports each `consoleFeature` from the tool's
  `dist` (normal package dep; resolved via `dist` typings).
- Add `packages/console` and `packages/console-theme` to the root `tsconfig.json`
  references (after the three tools) and a `hello-console` example. Build order:
  tools → console.

## Testing

- **Contract/unit:** nav derivation (order sort; icon-less ⇒ deep-link, not in
  nav); `window.__CONSOLE__` injection shape; page id ↔ feature id agreement.
- **Integration (supertest):** `installConsole(app)` serves the shell at
  `/console`; aggregated APIs respond (`/mcp-inspector/api/manifest`,
  `/context-explorer/api/...`, `/explorer`); the `auth` gate returns 401 when set;
  the standalone `installX` paths still serve their own shells unchanged.
- **Browser smoke:** open `/console`, switch panels via the sidebar, confirm
  each renders and invokes (manual, as already done for the inspector).

## Out of scope (v1)

- Build-time auto-discovery / virtual modules (a Vite plugin).
- Runtime module federation / dynamic panel loading.
- Re-basing tool APIs under `/console/api/*`.
- `swagger-ui-react` or a native OpenAPI viewer (iframe for now).
- Multi-tenant scoping, RBAC roles (only a coarse `auth` gate in v1).

## Phasing

1. `@agentback/console-theme` — extract shared CSS; tools import it (no
   behavior change). Lands independently.
2. `context-explorer` + `mcp-inspector` config-flow refactor (`makeApi`/props)
   - `./console` page exports + `consoleFeature`. Standalone behavior unchanged.
3. `rest-explorer` `SwaggerPanel` + `consoleFeature`.
4. `@agentback/console` package (shell, `installConsole`, `pages.ts`) +
   `hello-console` example + tests.
