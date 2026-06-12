# @agentback/rest-explorer

> Mount Swagger UI 5.x at `/explorer` against a `RestApplication`'s live `/openapi.json`.

Serves Swagger UI from `swagger-ui-dist` with a custom theme (warm-paper background, Fraunces serif
headings, JetBrains Mono for paths, oxblood accent) that matches the context-explorer and mcp-inspector
UIs. The index HTML is generated server-side so the spec URL is baked in — no CDN, no petstore demo.

Also exports a `ConsoleFeature` (`apiConsoleFeature`) for embedding the explorer as an iframe panel in
`@agentback/console`.

## What it provides

- `installExplorer(app, options?)` — mount Swagger UI on a `RestApplication`; call after registering controllers, before `app.start()`
- `mountExplorer(server, options?)` — lower-level form that takes a `RestServer` directly
- `apiConsoleFeature(options?)` — returns a `ConsoleFeature` that installs the explorer and advertises the iframe URL to the console shell
- `ExplorerOptions` — `{path?, specUrl?, title?}`

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {installExplorer} from '@agentback/rest-explorer';

const app = new RestApplication();
app.restController(MyController);

await installExplorer(app, {
  path: '/explorer', // default
  specUrl: '/openapi.json', // default
  title: 'My API',
});

await app.start();
// Swagger UI → http://localhost:3000/explorer/
// OpenAPI doc → http://localhost:3000/openapi.json
```

**Within `@agentback/console`** (the console handles the install):

```ts
import {installConsole, apiConsoleFeature} from '@agentback/console';
import {apiConsoleFeature as explorerFeature} from '@agentback/rest-explorer';

await installConsole(app, {features: [explorerFeature()]});
```

**Standalone on a bare `RestServer`** (no `RestApplication`):

```ts
import {mountExplorer} from '@agentback/rest-explorer';

const server = await app.get('servers.RestServer');
mountExplorer(server, {path: '/docs'});
```

**Options:**

| Option    | Default           | Notes                                                  |
| --------- | ----------------- | ------------------------------------------------------ |
| `path`    | `'/explorer'`     | Mount point; `GET /explorer` redirects to `/explorer/` |
| `specUrl` | `'/openapi.json'` | Passed to `SwaggerUIBundle({url: ...})`                |
| `title`   | `'API Explorer'`  | `<title>` in the generated HTML                        |

## Layering

Depends on: `@agentback/rest`, `express ^4`, `swagger-ui-dist ^5`. No dependency on
`@agentback/openapi` at runtime (it relies on `RestApplication` serving `/openapi.json`).
Sits above `rest` and is consumed optionally — `rest` works without it. The `./console` subpath
export (`src/client/console-page.tsx`) is a React component consumed by `@agentback/console`'s
esbuild bundle; it is not part of the server-side `dist/`.
