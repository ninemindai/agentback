# Unreleased

Notes for the next release, collected as changes land. Rename to the version
when it is cut.

## ✨ New

### Host-extension seams for MCP — `@agentback/mcp`

P1-7 phase 1a ([proposal](../proposals/host-extensions.md)). Hosts read metadata
beyond MCP Apps: ChatGPT's `openai/*` keys and Claude's widget `domain`.
`@agentback/mcp` now carries it through generic seams, checked when the
decorator is applied:

- `@tool({icons, annotations, extend})`. `extend` takes
  `toolFragment({ui?, annotations?, meta?, check?})`; a fragment's `check` runs
  against the resolved options, including the real `input:` schema.
- `@resource({title, icons, extend})` and the new **`@appResource`**
  (`csp`, `permissions`, `domain`, `prefersBorder`, …), which emits the typed
  `_meta.ui` on the `resources/read` content item.
- **`resourceContent({text} | {blob}, {mimeType?, meta?})`** for binary
  resources (served base64) and per-call `_meta`.
- `MCPServerConfig.{title, icons, websiteUrl, capabilities}`. `capabilities`
  accepts `extensions`/`experimental` and reaches both `initialize` and
  `server/discover`.
- `toolCostReport()` entries gain `iconBytes`.
- `mcp-inspector` shows annotations, icons, `_meta`, content-item `_meta` and
  server capabilities.
- `examples/hello-mcp-apps` gains `start:http` for remote hosts.
- **`create-agentback --mcp-apps`** (hybrid; also `agentback new --mcp-apps`)
  scaffolds a working widget tool: an ext-apps view bundled with esbuild, an
  `@appResource` serving it, and Claude's `domain` derived from `PUBLIC_URL`.
- `MCPServer.servedTools()` / `toolConflicts()` report what a runtime-mounted
  duplicate tool name suppressed; `toolCostReport()` prices only served tools
  and lists the conflicts as `suppressed`, and `mcp-inspector` shows them as a
  banner.
- Tool, resource and server `icons` need a non-empty `src`, and `*Hint`
  annotations must be booleans — checked at decoration (server icons at
  construction).

`toolFragment`, `resourceFragment`, `@appResource` and `resourceContent` are
**experimental**: their shapes may change in a minor release while the host
specs settle.

See the "Host extensions" section of
[docs/guides/mcp-apps-widgets.md](../guides/mcp-apps-widgets.md).

## ⚠️ Behaviour changes

- **Duplicate tool names now throw at `start()`**, naming both members.
  Before, the last registration silently won. The same class bound twice (e.g.
  `app.controller(C)` + `app.service(C)`) is still accepted. `buildServer()`
  never throws on a duplicate (under stateless HTTP it runs per request): one
  mounted later — by a `perSession` binder or a plugin — is resolved
  root-nearest first, so an app-level tool always wins, and the conflict is
  logged once per app and pair. If the winner is scope-hidden from a caller,
  the name is hidden rather than served by the loser.
- **Host `_meta` keys need a vendor prefix.** Every key a fragment or
  `resourceContent()` contributes outside `ui` must look like `openai/x` or
  `com.example/x`; an unprefixed key throws, since unprefixed keys are reserved
  for MCP.
- **`confirm:` tools now publish `annotations: {destructiveHint: true}`** on
  `tools/list` unless the tool sets `destructiveHint` itself. Snapshot tests of
  `tools/list` change. `confirm:` together with `readOnlyHint: true` throws at
  decoration.
- **`ToolUiMeta.resourceUri` is optional** — `ui: {visibility: ['app']}` with
  no widget is valid. Code that reads `meta.ui.resourceUri` now sees
  `string | undefined`.
- **`MCPServer.readResource()` returns `ResourceContentItem[]`**, a text-or-blob
  union (`text?: never` on the blob branch, so `.text` still type-checks as
  `string | undefined`).
