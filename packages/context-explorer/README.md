# @agentback/context-explorer

A read-only web UI for inspecting an application's LoopBack DI container —
every binding's key, scope, type, tags, source, and (in the raw view) injection
metadata, plus the parent-context chain.

Unlike `@agentback/mcp-inspector`, the JSON API is exposed through a real
`@api`-decorated REST controller registered via `app.restController(...)`,
dogfooding the framework's own routing decorators. The UI is a small React SPA
bundled with esbuild and served as a static asset.

Four views:

- **Explore** — a three-pane shell: a facet nav (filter by kind, scope, type,
  context, tag), a results list with scope/type color badges and kind/tag chips,
  and a detail pane showing the selected binding's full wiring (depends-on /
  depended-on-by, configured-by, extensions, sibling registration, routes,
  tools).
- **Graph** — a node-edge dependency graph (React Flow + dagre layout): a node
  per binding, an arrow from each binding to the bindings it injects, laid out
  left-to-right with dependencies on the left. Pan/zoom/drag; click a node to
  highlight it and its incident edges.
- **Hierarchy** — the context tree: each context node nested under its parent,
  carrying its own bindings.
- **Raw** — the full `inspect()` JSON, including injection metadata.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {installContextExplorer} from '@agentback/context-explorer';

const app = new RestApplication();
// ... register controllers / services / bindings ...
await installContextExplorer(app); // before app.start()
await app.start();
// -> Context Explorer UI at http://host:port/context-explorer/
```

Options:

| option  | default             | meaning                          |
| ------- | ------------------- | -------------------------------- |
| `path`  | `/context-explorer` | URL path where the UI is mounted |
| `title` | `Context Explorer`  | page title                       |

The JSON API is fixed at `/context-explorer/api`:

- `GET /context-explorer/api/model` — the consolidated explorer model:
  `{app, contexts[], bindings[]}`. Each binding node carries scope, type, source,
  `tags` (name+value), `kinds`, `dependsOn` (direct-key injections), and — where
  applicable — `extensionPoint`/`extensionFor`, `configurationFor`,
  `lifeCycleGroup`, `routes` (controllers), and `tools` (MCP servers).
- `GET /context-explorer/api/inspect` — the raw `inspect()` tree for the Raw
  view (`includeInjections`/`includeParent` flags, both default `true`).

Read-only: bindings are never resolved, so secrets are never exposed. The sole
exception is `APPLICATION_METADATA` (a package.json object) for the app identity
card.

## Build

The React client (`src/client/`) is bundled by **esbuild**, separately from the
`tsc -b` project-reference build. The repo's root `pnpm build` runs both
(`tsc -b && pnpm -r run build:client`).

To build/test this package alone you must produce the client bundle first, since
the integration test fetches it:

```bash
pnpm -F @agentback/context-explorer build         # tsc + esbuild
# or just the client bundle:
pnpm -F @agentback/context-explorer build:client
```

`installContextExplorer` throws a clear error if the bundle is missing.
