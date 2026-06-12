# @agentback/mcp-inspector

An in-process web UI for inspecting and exercising an MCP server's tools,
resources, and prompts — without going through an MCP transport. The JSON API
is exposed through a real `@api`-decorated REST controller registered via
`app.restController(...)` (dogfooding the framework's own decorators); the UI is
a React SPA bundled with esbuild and served as a static asset.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installInspector} from '@agentback/mcp-inspector';

const app = new RestApplication();
app.component(MCPComponent);
app.configure('servers.MCPServer').to({name: 'my-mcp', version: '1.0.0'});
app.service(MyTools); // @mcpServer() class with @tool/@resource/@prompt

await installInspector(app); // before app.start(); resolves the MCP server from DI
await app.start();
// -> MCP Inspector UI at http://host:port/mcp-inspector/
```

`installInspector` throws if no MCP server is bound at `servers.MCPServer`
(add `MCPComponent` first).

Options:

| option  | default          | meaning                          |
| ------- | ---------------- | -------------------------------- |
| `path`  | `/mcp-inspector` | URL path where the UI is mounted |
| `title` | `MCP Inspector`  | page title                       |

## Features

- **Tools** — schema-aware input form per tool (checkbox/number/select/JSON
  textarea derived from the tool's Zod-generated JSON Schema), Run button,
  pretty result rendering, inline per-field validation errors, and the output
  schema (when declared). Filter tools by name/description.
- **Resources** — Read button → renders the MCP `{contents:[…]}` wire shape.
- **Prompts** — Get button → renders the MCP `{messages:[…]}` wire shape.
- **History** — an in-memory panel logging every invocation (kind, name,
  status, elapsed ms), each expandable to its result. Cleared on reload.
- **Folding** — the Tools/Resources/Prompts sections collapse, and each tool
  card folds to its name + description (with a Tools "collapse all" / "expand
  all" control) so large servers stay scannable.

## API

Fixed at `/mcp-inspector/api`:

- `GET /manifest` — `{server, tools[], resources[], prompts[]}`; tools carry
  Zod-derived `inputSchema`/`outputSchema`.
- `POST /tools/{name}/call` — body is the tool's input (validated by the tool's
  own Zod schema); returns the raw result, or `400 {error:{statusCode, message,
details}}` (`details` = Zod issues) on invalid input / unknown tool.
- `POST /resources/{name}/read` — `{contents:[…]}`; `400` on unknown.
- `POST /prompts/{name}/get` — `{messages:[…]}`; `400` on unknown.

## Build

The React client (`src/client/`) is bundled by **esbuild**, separately from the
`tsc -b` project-reference build (`src/client` is excluded from `tsconfig.json`).
The repo's root `pnpm build` runs both (`tsc -b && pnpm -r run build:client`).

To build/test this package alone, produce the client bundle first (the
integration test fetches it):

```bash
pnpm -F @agentback/mcp-inspector build         # tsc + esbuild
pnpm -F @agentback/mcp-inspector build:client  # just the bundle
```

`mountInspector` throws a clear error if the bundle is missing.
