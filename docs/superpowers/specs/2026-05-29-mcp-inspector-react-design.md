# MCP Inspector → React — Design

**Date:** 2026-05-29
**Status:** Approved, implementing

## Summary

Rewrite the `@agentback/mcp-inspector` UI from vanilla DOM JS to a React
SPA (bundled with esbuild, same pattern as `@agentback/context-explorer`),
convert its management API from raw express routes to a dogfooded `@api`
controller, and add interactive resource-read / prompt-get plus a call-history
panel. The latter requires new public methods on the `@agentback/mcp`
package.

## Scope decisions (resolved during brainstorming)

1. **Improvement level:** Port to React + visual consistency with
   context-explorer + targeted UX wins (schema-aware inputs, inline Zod errors,
   pretty result rendering, tool filter) **and** the big features (interactive
   resources/prompts, call history).
2. **API style:** Convert the management API to an `@api` REST controller
   registered via `app.restController(...)`, replacing the raw express routes.
3. **Layout:** Single-page stacked sections (Tools / Resources / Prompts), not a
   master/detail split — the inspector acts on items inline.

## Architecture

### Package(s) touched

- `@agentback/mcp` — new public `readResource` / `getPrompt` methods (+ a
  dedup refactor of the SDK-handler bodies).
- `@agentback/mcp-inspector` — controller rewrite + React UI + esbuild
  build, mirroring `context-explorer`.
- `examples/hello-hybrid` — updated caller (signature change).

### `@agentback/mcp` additions

The resource/prompt dispatch is currently inlined and duplicated inside
`registerAll()`. Factor each into a private method and expose a public entry
point that mirrors `callTool`:

```ts
// Reusable handler bodies (return exactly what an MCP client receives):
private async dispatchResource(r): Promise<{contents: {uri; mimeType; text}[]}> { … }
private async dispatchPrompt(p): Promise<{messages: {role; content}[]}> { … }

async readResource(name: string) {
  const r = this.collectAllResources().find(x => x.meta.name === name);
  if (!r) throw new Error(`Unknown resource: ${name}`);
  return this.dispatchResource(r);
}
async getPrompt(name: string) {
  const p = this.collectAllPrompts().find(x => x.meta.name === name);
  if (!p) throw new Error(`Unknown prompt: ${name}`);
  return this.dispatchPrompt(p);
}
```

`registerAll()` is refactored to call `dispatchResource`/`dispatchPrompt`,
removing the inline duplication. Resources/prompts take **no arguments** in the
current dispatch (the handler invokes the method with no args), so read/get are
parameterless. The wire-shape wrapping (`text: typeof result === 'string' ?
result : JSON.stringify(result)`, default `mimeType` `text/plain`) is preserved
exactly.

### `@agentback/mcp-inspector` — the controller

Raw express routes are replaced by an `@api` controller registered by
`installInspector`. It injects the MCP server from DI (`MCPBindings.SERVER`):

```ts
const NamePath = z.object({name: z.string()});
const CallBody = z.record(z.string(), z.unknown()); // dynamic per-tool input
const Manifest = z
  .object({
    server: z.object({name: z.string(), version: z.string()}),
    tools: z.array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        inputSchema: z.any().optional(),
        outputSchema: z.any().optional(),
      }),
    ),
    resources: z.array(
      z.object({
        name: z.string(),
        uri: z.string(),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    ),
    prompts: z.array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
      }),
    ),
  })
  .loose();

@api({basePath: '/mcp-inspector/api'})
export class McpInspectorController {
  constructor(@inject(MCPBindings.SERVER) private readonly mcp: MCPServer) {}

  @get('/manifest', {response: Manifest})
  async manifest() {
    /* server + tools/resources/prompts; Zod→JSON via zodToOpenApiSchema */
  }

  @post('/tools/{name}/call', {
    path: NamePath,
    body: CallBody,
    response: z.any(),
  })
  async call(input) {
    return this.invoke(() => this.mcp.callTool(input.path.name, input.body));
  }

  @post('/resources/{name}/read', {path: NamePath, response: z.any()})
  async read(input) {
    return this.invoke(() => this.mcp.readResource(input.path.name));
  }

  @post('/prompts/{name}/get', {path: NamePath, response: z.any()})
  async getPrompt(input) {
    return this.invoke(() => this.mcp.getPrompt(input.path.name));
  }

  // Shared: run, or rethrow as a 400 carrying Zod issues as `details`.
  private async invoke(fn) {
    try {
      return await fn();
    } catch (err) {
      const e = err as Error & {statusCode?: number; details?: unknown};
      e.statusCode = 400;
      const issues = (err as {issues?: unknown}).issues;
      if (issues) e.details = issues;
      throw e;
    }
  }
}
```

- **Error envelope:** errors flow through `RestServer.sendError`, producing
  `{error: {statusCode: 400, message, details?}}` (`details` = Zod issues when
  present). This replaces today's `{ok, error, issues}` shape. Success returns
  the raw result / wire shape at HTTP 200.
- `response: z.any()` keeps the dynamic results permissive (logged-on-mismatch
  REST validation never rejects).

### `installInspector` / `mountInspector` signature change

```ts
installInspector(app: RestApplication, options?: InspectorOptions): Promise<void>
mountInspector(server: RestServer, options?: InspectorOptions): void
```

The `mcpServer` parameter is dropped — the controller resolves it via DI.
`installInspector` throws early with a clear message if `MCPBindings.SERVER`
isn't bound (you must have an MCP server to inspect). `InspectorOptions` keeps
`path` (default `/mcp-inspector`) and `title` (default `MCP Inspector`).
Callers updated: the integration test and `examples/hello-hybrid` (drop the
`mcpServer` arg).

## UI

Single-page React SPA, same visual family as context-explorer (CSS vars,
light/dark, cards, monospace, badges). Header: title · `server vX.Y` · tool
filter · `History (N)` toggle. Sections: Tools / Resources / Prompts.

### Component tree

```
src/client/
  main.tsx                 # createRoot(<App/>)
  App.tsx                  # fetch /manifest; filter + history state; renders sections + HistoryPanel
  api.ts                   # fetchManifest, callTool, readResource, getPrompt; typed errors
  components/
    ToolCard.tsx           # one tool: schema-driven form, Run, result/error
    SchemaField.tsx        # one input rendered by JSON-Schema type
    ResourceCard.tsx       # uri/desc/mimeType + Read button → JsonView(contents)
    PromptCard.tsx         # name/desc + Get button → JsonView(messages)
    HistoryPanel.tsx       # in-memory invocation log, newest first
    JsonView.tsx           # pretty JSON, success/error variant, (status, ms) line
  lib/
    schema.ts              # read {type, enum, minimum, minLength, required, …} from a JSON-Schema property
    coerce.ts              # schema-aware coercion of form values → typed JSON
```

### Polish features

- **Schema-aware inputs** (`SchemaField`): `boolean`→checkbox, `integer`/
  `number`→number input, `enum`→select, `string`→text, `object`/`array`→JSON
  textarea; fallback JSON textarea for exotic schemas (`anyOf`, nested).
  Required marked `*`; constraints shown as a hint (`1–10`, `min 1`).
- **Inline per-field errors:** on a 400, map `error.details` (Zod issues) by
  `issue.path[0]` to the field; issues with no path show in a card-level banner.
- **Pretty results** (`JsonView`): formatted JSON, success vs error color, and a
  `(status · elapsed ms)` line.
- **Tool filter:** substring over tool name + description with a `visible/total`
  count.

### Big features

- **Interactive resources/prompts:** Read/Get buttons POST to the new routes and
  render the returned `contents`/`messages` via `JsonView`.
- **Call history:** `App` owns an in-memory array (cap 100, newest first). Each
  invocation records `{id, at, kind: 'tool'|'resource'|'prompt', name, ok,
status, ms, payload}`. `App` passes a `record(entry)` callback to the cards;
  `HistoryPanel` lists entries (kind badge · name · status · ms), each
  expandable to a `JsonView`. Cleared on reload (no persistence).

## Build & serving (mirrors context-explorer)

- `src/client/` excluded from `tsconfig.json`; `build-client.mjs` runs esbuild
  (`main.tsx` → `dist/client/main.js`, ESM, minified, sourcemap).
- Package `build` = `tsc -b && node build-client.mjs`; `build:client` =
  `node build-client.mjs`. Root `pnpm build` already runs
  `pnpm -r run build:client`.
- devDeps add `esbuild`, `react`, `react-dom`, `@types/react`,
  `@types/react-dom`. Existing deps (`mcp`, `openapi`, `rest`, `express`, `zod`)
  stay; `openapi` now also provides `@api`/`@get`/`@post`.
- Shell: server-rendered `<div id="root">` + `<script type=module
src=…/assets/main.js>`; all CSS inlined in a `<style>` (no React Flow here, so
  esbuild emits only `main.js`). Served via `express.static` at
  `/mcp-inspector/assets`. `mountInspector` throws if the bundle is missing.

## Testing

- **mcp package:** focused test that `readResource`/`getPrompt` return the
  `{contents}`/`{messages}` wire shapes and throw `Unknown resource|prompt` on
  bad names.
- **inspector integration** (rewritten):
  - Fixture gains one `@resource` and one `@prompt` alongside the echo/add tools.
  - Manifest API tests — **unchanged** (server info, per-tool `inputSchema`,
    conditional `outputSchema`).
  - Tool-call tests — new envelope: success → raw result (`{echoed:'hi'}`);
    invalid input → `400 {error:{statusCode:400, message:/Invalid input for tool
echo/, details:[{code:'too_small'}]}}`; unknown tool → `400 …/Unknown tool/`.
  - Resource/prompt routes — `POST /api/resources/{name}/read` →
    `{contents:[…]}`; `/api/prompts/{name}/get` → `{messages:[…]}`; 400 on
    unknown.
  - UI: `/mcp-inspector/` serves HTML with `#root` + `assets/main.js`;
    `/mcp-inspector/assets/main.js` serves JS. (Replaces the `coerceByType`
    string assertion. Requires `build:client` before `pnpm test`.)

## Out of scope

- Resource/prompt **arguments** (URI-template `@arg` is not wired into the
  current dispatch; read/get stay parameterless).
- History persistence (in-memory only).
- Auth-gating the inspector (caller's middleware concern).

## References

- `packages/mcp/src/mcp.server.ts` — `callTool`/`dispatch*`, `registerAll`.
- `packages/context-explorer/` — the React + esbuild template this mirrors.
- `packages/mcp-inspector/src/index.ts` — current raw-express implementation.
- `examples/hello-hybrid/src/index.ts` — caller to update.
