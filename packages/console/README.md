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
