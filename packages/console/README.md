# @agentback/console

A unified developer **console** that composes the framework's UIs — the
**context explorer**, the **REST/OpenAPI (Swagger) explorer**, and the **MCP
inspector** — behind one shell with shared chrome and theme, served at
`/console`.

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installConsole} from '@agentback/console';

const app = new RestApplication();
app.component(MCPComponent);
// …register controllers / MCP tools…
await installConsole(app, {
  title: 'my console',
  auth: myAuthMiddleware,
}); // -> /console
await app.start();
```

## Composition model

The console is composed by **explicit static registration** (no build-time
auto-discovery, no runtime federation), via a two-sided contract:

- **Client** — each tool package exports `pages: ConsolePage[]` from its
  `./console` entry; `src/client/pages.ts` imports and concatenates them, and
  esbuild bundles one SPA. The sidebar nav is derived from the page list
  (sorted by `order`; pages without an `icon` are routable but hidden from nav).
- **Server** — each tool exports a `ConsoleFeature` (`contextConsoleFeature()`,
  `apiConsoleFeature()`, `mcpConsoleFeature()`) that registers its API
  controller (no standalone shell) and advertises the panel's `apiBase`, any
  per-panel `extra` config, and its component CSS. `installConsole` installs the
  features and injects a `window.__CONSOLE__` config the shell reads.

Add a panel by installing its package and adding one import + spread to
`pages.ts` plus one entry to the `features` list — no changes to the shell.

```ts
// a tool's ./console entry
import {defineConsolePage} from '@agentback/console';
export const pages = [
  defineConsolePage({id: 'mine', title: 'Mine', icon: '◆', order: 40,
    route: '/mine', component: ({apiBase}) => <MyPanel apiBase={apiBase} />}),
];
```

## Build ordering (editing another package's panel/dock)

The console's `esbuild` step bundles **one SPA** (`dist/client/main.js`) by
following each tool's `./console` export to its client **source** (e.g.
`@agentback/console-chat`'s `Dock.tsx`). So a panel or dock authored in another
package is compiled *into the console's bundle*, not served from its own `dist/`.

Consequence: **after editing another package's client code (a `ConsolePage`
component, the chat `Dock`, etc.), you must rebuild `@agentback/console`** — not
just the package you edited — for the served `/console` page to change. Rebuilding
only the owning package updates its own `dist/` but leaves the console's `main.js`
stale, and restarting the host app won't help (it serves the prebuilt bundle).

```bash
pnpm -F @agentback/console-chat build   # the package you edited (types/tests)
pnpm -F @agentback/console build         # REQUIRED: re-bundles the SPA with your change
```

Two related gotchas when verifying a change landed:

- The React/JSX (aria-labels, button text) lives in the separate
  `/console/assets/main.js` bundle — **not** in the HTML returned by
  `curl /console`. Grep the bundle, not the shell HTML.
- Component **CSS** and the `window.__CONSOLE__` config *are* inlined in the
  shell HTML (the theme CSS is server-injected via `THEME_CSS`), so those reflect
  a server restart without a console rebuild — which is why CSS-only and
  config-only changes can appear to work while a JSX edit silently doesn't.

## Options

```ts
installConsole(app, {
  basePath, // default '/console'
  title, // default 'AgentBack console'
  features, // default: [context, api, mcp]
  auth, // Express middleware for production deployments (see Security)
  unsafeAllowUnauthenticated, // explicit local-development opt-in
});
```

The individual tools still install standalone (`installContextExplorer`,
`installExplorer`, `installInspector`) — the console is an additional, optional
composition layer.

## Security

The console aggregates **sensitive** surfaces: the context explorer exposes DI
container internals, and the MCP panel (via `@agentback/mcp-connect`) can
trigger **outbound** connections and invoke tools on connected remote servers.
Production deployments should pass `auth` to gate the console UI **and** the
aggregated panel APIs (each feature's `apiBase`, plus the mcp-connect base)
behind your app's auth middleware — it is registered ahead of the panel routes
in the Express stack. The server is the authority; client-side nav is cosmetic.

```ts
await installConsole(app, {
  auth: (req, res, next) => {
    if (req.user?.isAdmin) return next();
    res.status(401).end();
  },
});
```

For local development only, you can mount the console without server-side auth
by making that posture explicit:

```ts
await installConsole(app, {
  unsafeAllowUnauthenticated: true,
});
```

## Live reflection

When your app restarts — e.g. the agent (or you) edits source and `build:watch`
rebuilds — the open console panels refresh automatically to show the new
structure. No configuration: it is on whenever the console is mounted.

How it works: the console serves a per-process boot id over a `GET
<basePath>/live` SSE stream. The client keeps that stream open; when a
reconnect returns a *new* boot id (the process restarted), the native explorers
(`context-explorer`, `schema-explorer`) refetch in place — your current
selection and filters are preserved — and the embedded panels (`rest-explorer`,
`mcp-inspector`) remount with fresh data. A transient network blip reconnects to
the *same* boot id and is ignored. A small "offline" indicator appears in the
sidebar while the stream is down. Node-host-only; SSE (no WebSocket).
