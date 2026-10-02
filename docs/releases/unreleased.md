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

### Capability contributions and per-host presentation — `@agentback/mcp`, `@agentback/mcp-http`

P1-7 phase 1b ([proposal](../proposals/host-extensions.md) §4.6–4.7):

- **`contributeCapabilities(app, {extensions?, experimental?})`** advertises
  capabilities from code (an installer, a host adapter). It returns an
  `Installed`; contributions merge with `MCPServerConfig.capabilities`, and
  the same entry declared differently by two sources throws at the call
  (and `start()` re-checks).
- **`@appResource({domain: fn})`** resolves the widget sandbox domain per
  `resources/read` from `{client, mount, meta, request, context}`.
- **`installMcpHttp({host})`**: mount the endpoint once per host
  (`/mcp/claude`, `/mcp/chatgpt`); the hint reaches handlers as
  `MCPBindings.REQUEST_MOUNT` on both hosts and every era.
- **`MCPBindings.REQUEST_META`** — the request's `params._meta`, frozen.
- `/llms.txt` lists one MCP section per mount.

### ChatGPT adapters — `@agentback/mcp-openai` (new, experimental)

P1-7 phase 3 ([proposal](../proposals/host-extensions.md) §6–8). Typed
adapters for OpenAI's MCP extensions, built only on `@agentback/mcp`'s generic
seams:

- `openaiUi` / `globalEntrypoint` / `threadEntrypoint` / `settingsEntrypoint` /
  `fileEntrypoint`, `mentionSearch()` and `displayModes()`, each checked when
  the decorator runs.
- `openaiForm` with `textField` / `choiceField` / `resourceField`, for
  `elicit.ask`'s `extended` form.
- `resourcePath()`, which confines `_meta["openai/resource"].path`.
- `installSettings()`: structured settings keyed per verified user.

Also new:

- `isSynthesizedPrincipal()` / `isVerifiedPrincipal()` in `@agentback/mcp`.
- `callTool` / `readResource` `{simulate}`.
- **"Call as"** client profiles in `mcp-inspector`.
- **`mcp-host` relays elicitation and, opt-in, request `_meta`.**
  - An upstream tool's question reaches the downstream client
    (`relayElicitation`, on by default; `elicitationTimeoutMs`, 10 minutes).
  - Vendor `_meta` keys are forwarded when listed (`relayMeta`, off by
    default).
  - Upstreams now connect with automatic version negotiation, so a 2026
    upstream is spoken to in its own revision. Per upstream,
    `versionNegotiation: 'legacy'` restores the old handshake.
  - The README lists the two limitations that remain.
- `@agentback/mcp-client` `connectMcp({clientOptions, beforeConnect})`.
- `examples/hello-mcp-apps` gains a ChatGPT entrypoint, display modes, a
  settings page and a `/mcp/claude` per-host mount.

### Elicitation: ask the user mid-call — `@agentback/mcp` (experimental)

P1-7 phase 2 ([proposal](../proposals/host-extensions.md) §5). A tool injects
`MCPBindings.ELICIT` and calls `await elicit.ask(key, {message, standard})`
(or `askAll`). The tool re-runs from the top each round with earlier answers
replayed. Works for 2026 clients and 2025 sessions/stdio that declared
`elicitation`; other callers get `elicitation_unavailable`. Also new:
`MCPBindings.REQUEST_CLIENT`, `hasClientExtension()`,
`MCPBindings.REQUEST_STATE_KEY`, `MCPServer.serveTransport()`,
`McpDispatchInfo.inputRequired`, `createTestApp({mcpEra, mcpElicit})`,
**`elicit.once(key, fn)`** (expensive pre-ask work runs once per call, not
once per round), **question forms in `mcp-inspector`** (an asking tool runs
through a real 2026 client; `POST /tools/{name}/answer` continues it), and the
error codes `elicitation_unavailable` / `elicitation_unsupported` /
`elicitation_declined`.

## ⚠️ Behaviour changes

- **An `elicit.ask` `extended` form now goes only to 2026-era clients.** A 2025
  connection that declared `openai/elicitation` used to get the extended
  schema through standard `elicitation/create`. OpenAI's spec puts extended
  forms on its own `openai/elicitation/create` method for that era, so those
  clients now get the `standard` form. An ask with only an `extended` form
  answers `elicitation_unsupported` there.
- **`authInfoToPrincipals` marks the principal it synthesizes from a
  `clientId`** (`isSynthesizedPrincipal`), and the `localPrincipal` fallback
  is now bound as a marked copy of the configured profile. Same fields, not
  the same object. Both are otherwise unchanged.

- **`confirm:`'s native prompt now carries its token in a signed envelope.**
  On the 2026 era the `requestState` is no longer the raw store token; a raw
  token sent as `requestState` is refused (`confirmation_invalid`). The
  envelope is bound to the caller, and the prompt's token can no longer be
  replayed through the `confirmationToken` input property or used on a retry
  that drops the `elicitation` capability (both previously skipped the human
  answer). The `confirmationToken` token dance itself is unchanged.
  **Multi-instance deployments must share one key** — bind
  `MCPBindings.REQUEST_STATE_KEY` (≥ 32 bytes) or set
  `AGENTBACK_MCP_STATE_KEY` — or a retry landing on another instance is
  refused; the refusal is logged. A key shorter than 32 bytes fails
  `start()`.
- **Metering bills a multi-round MCP call once**, on its final round. A
  `confirm:` prompt round used to emit a usage event of its own.
- **`createTestApp`'s in-memory MCP client is served through
  `MCPServer.serveTransport()`** (both eras on one connection). A 2025 client
  is still the default.
- `examples/hello-mcp` gains a `greet` tool that asks the user's name.
- `selectTools` (the agents and CLI projections) now excludes tools that
  inject `MCPBindings.ELICIT`, and throws if one is named in `include`.

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
