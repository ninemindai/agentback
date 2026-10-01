# Proposal P1-7: MCP host extensions — ChatGPT and Claude from the same contract

**Status:** Design (2026-10-01). Not scheduled. Phase 1 is small and
host-neutral and can start now; phases 2–3 want a real consumer first.
**Packages touched:** `mcp` (seams), `mcp-http` (no API change; the per-request
servers pick up the new config), `mcp-host` (documented limitation),
`mcp-inspector` (display only), one new package (`@agentback/mcp-hosts`), one
example.
**Builds on:** [P1-6 MCP Apps](p1-6-mcp-apps.md) (this completes its phase-1
resource half), [MCP `2026-07-28` stateless](mcp-2026-stateless.md) (the MRTR
and per-request-server constraints below come from it),
[revertible installs](revertible-installs.md) (every new `install*` follows
that contract).

---

## 1. Context

Two hosts now publish their own layer on top of MCP and
[MCP Apps (SEP-1865)](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx):

- **OpenAI MCP Extensions**
  ([spec](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md),
  `@openai/mcp-extensions` 0.1.0, 2026-09-29). This is a large `openai/*`
  namespace:
  - **Entrypoints:** sidebar, thread tab and file-type handlers, via
    `_meta["openai/ui"]` on a tool.
  - **Display modes:** `_meta["openai/ui"]` on the widget's resource content.
  - **Structured settings:** an `openai/settings` server capability naming a
    read tool and an update tool.
  - **Composer @-mentions:** a tool marked with
    `_meta["openai/extensions"]["mentions/search"]`.
  - **Extended form elicitation:** `x-openai-*` keys on the requested schema,
    sent through MRTR or the custom `openai/elicitation/create` method.
  - **File access:** `_meta["openai/resource"].path` on tool calls coming from
    a file entrypoint.
- **Claude** has no extension spec, but it does have host conventions, the one
  that matters being `_meta.ui.domain`. Its documented format is the first 32
  hex characters of SHA-256(server URL) + `.claudemcpcontent.com`
  ([getting started](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md)).
  The MCP Apps spec says plainly that the domain format is **host-dependent**.

### Neither SDK can be dropped in

- **OpenAI's server SDK is v1.** `@openai/mcp-extensions/server` peers
  `@modelcontextprotocol/sdk ^1.29` (v1) and wraps the v1
  `McpServer.registerTool`. AgentBack runs on the v2 split packages and
  registers through `setRequestHandler`. We do not reintroduce v1 (see
  CLAUDE.md, "Deps and versioning").
- **Its schemas come with v1 attached.** They import `IconSchema`,
  `ResourceLinkSchema` and `ToolSchema` from v1 `sdk/types.js`, so the shapes
  get written fresh in Zod here. They are small.
- **Its widget half targets ext-apps 1.x.** `@openai/mcp-extensions/app` peers
  ext-apps `^1.7.5`. ext-apps `2.0.3` (what `hello-mcp-apps` uses) peers SDK v2
  (`@modelcontextprotocol/{client,core,server} ^2`). It is a browser-side
  concern and is covered in §9.

### The transport is already ready

Verified against `@modelcontextprotocol/server@2.1.0`:

- **Capabilities.** `ServerCapabilities` accepts `extensions` and
  `experimental`, and the 2026 `server/discover` result copies them through
  unchanged (`discoverAdvertisedCapabilities` is `{...capabilities}`).
- **Tool and server fields.** `Tool` accepts `icons` and `annotations`;
  `Implementation` accepts `icons`.
- **Custom methods.** `ctx.mcpReq.send` takes a result schema for non-spec
  methods.
- **Form schemas survive.** `inputRequired.elicit` passes a plain-JSON
  `requestedSchema` through without re-parsing (`normalizeElicitInputParams`
  only parses Standard Schema input), and the 2026 encoder deletes only named
  fields. `x-openai-*` keys should therefore reach the wire. Phase 2's first
  test pins this.

**Every gap is in AgentBack's emission layer.** That is the subject of this
proposal.

## 2. The gaps, with locations

| #   | Gap                                                                                                                                                         | Where                                                                    | Blocks                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| G1  | A `tools/list` entry is only `name`/`title`/`description`/schemas/`_meta.ui`; no `icons`, `annotations` or other `_meta`                                    | `compileTool`, `packages/mcp/src/mcp.server.ts:235`                      | OpenAI entrypoints and mention marker; `readOnlyHint` on the settings read tool; sidebar icons             |
| G2  | `ToolUiMeta.resourceUri` is required                                                                                                                        | `packages/mcp/src/keys.ts:168`                                           | OpenAI mention tools, which carry `ui.visibility: ['app']` with no widget                                  |
| G3  | `dispatchResource` always returns one `text` item, `JSON.stringify`s objects, and has no way to return `_meta` or `blob`                                    | `packages/mcp/src/mcp.server.ts:453`                                     | MCP Apps `_meta.ui` (`csp`, `domain`, `prefersBorder`, `permissions`), OpenAI display modes, binary blobs  |
| G4  | Server capabilities are hardcoded `{tools, resources, prompts}` in two places; server info is `{name, version}` only                                        | `packages/mcp/src/mcp.server.ts:346` (stdio) and `:1120` (`buildServer`) | `openai/settings`; server `icons` (the sidebar icon fallback)                                              |
| G5  | No public, era-neutral view of client capabilities or request `_meta`; `mrtrContext` reads only `.elicitation`, and only on the 2026 era                    | `packages/mcp/src/mcp.server.ts:723`                                     | Checking `extensions["openai/elicitation"]`; reading `_meta["openai/resource"].path` without the raw extra |
| G6  | A user tool cannot elicit. An `input_required` return from a tool with `output:` fails output validation, and in-process `callTool` has no human            | `packages/mcp/src/mcp.server.ts:691`                                     | OpenAI extended forms and any custom elicitation                                                           |
| G7  | `mcp-host` keeps `_meta` (`{...tool, name}`), but prefixing renames tools that `_meta` and capabilities refer to by name; upstream capabilities are dropped | `packages/mcp-host/src/index.ts:230`                                     | Settings, previews and quick actions behind the gateway                                                    |

## 3. Principles

1. **The core gets host-neutral seams; host vocabulary goes in an adapter.**
   `@agentback/mcp` learns `annotations`, `icons`, static `_meta`, resource
   content metadata, capability contributions, client capabilities and
   elicitation. These are all standard MCP or MCP Apps concepts. The `openai/*`
   and Claude-domain vocabulary lives in `@agentback/mcp-hosts`, so each host's
   churn stays out of the core. This follows `mcp` / `mcp-http` and `payments`
   / x402.
2. **One source of truth, enforced at boot.** Where a host convention repeats
   something the framework already knows, it is _derived_, and contradictions
   throw at decoration time or at `app.start()`, never at the first call.
   Examples: a settings schema is a Zod object, `confirm:` implies
   `destructiveHint`, and an entrypoint's "must accept `{}`" is checked against
   the tool's own `input:`. See [agent-ergonomics](../agent-ergonomics.md).
3. **Static by default, dynamic by an explicit escape hatch.** Compiled tool
   entries are frozen and cached per (class, method), and that stays true.
   Per-request variation (the per-host `domain`) goes through a branded return
   value, as `fileResponse` does for REST.
4. **Host hints are not authorization.** `ui.visibility: ['app']`, entrypoints
   and `readOnlyHint` change how a host _presents_ a tool. They never decide
   who may call it; `@authorize` and `scope` still do.
5. **Every new `install*` returns `Installed`** and passes
   `runInstallConformance`.

## 4. Phase 1 — host-neutral core seams (`@agentback/mcp`)

### 4.1 `@tool`: `icons`, `annotations`, `meta` (G1)

```ts
@tool('cad.library', {
  output: Library,
  title: 'Parts Library',
  icons: [{src: LIBRARY_SVG_DATA_URI, mimeType: 'image/svg+xml'}],
  annotations: {readOnlyHint: true, openWorldHint: false},
  ui: {resourceUri: 'ui://bits/library'},
  meta: openaiUi({entrypoints: [{type: 'global'}]}), // from @agentback/mcp-hosts/openai
})
async library(): Promise<z.infer<typeof Library>> { … }
```

- **Types.** `icons?: Icon[]` and
  `annotations?: Omit<ToolAnnotations, 'title'>` are type re-exports from
  `@modelcontextprotocol/server`, the same way `AuthInfo` is re-exported
  today. `annotations.title` is left out because the top-level `title` is the
  single source.
- **`meta?: Record<string, JsonValue>`.** It is merged into the entry's
  `_meta` next to the existing `ui` emission. Checked at decoration time:
  - It must be plain JSON, since it is `deepFreeze`d and shared across
    callers.
  - `meta.ui` throws ("use the `ui:` option"), so `_meta.ui` has one source.
  - Keys under `io.modelcontextprotocol/` throw, because those are reserved
    for the SDK and spec.
- **Composing several fragments.** `mergeMeta(...fragments)` merges fragments
  from more than one host and throws on a duplicate top-level key.
- **Derived annotations:**
  - `confirm:` sets `destructiveHint: true` unless the author set it.
  - `confirm:` together with `readOnlyHint: true` throws at decoration: a
    read-only tool needs no confirmation, so one of the two declarations is
    wrong.
- **Tool cost.** `toolCostReport` gains an `iconBytes` column. A data-URI
  icon is in every `tools/list` response, and `_meta` usually never reaches
  the model, so icons are reported separately and not added to the token
  estimate.

### 4.2 `ToolUiMeta.resourceUri` becomes optional (G2)

`ui: {visibility: ['app']}` with no widget becomes valid. That is how OpenAI
marks a tool the host calls but the model never sees. The `ToolUiMeta`
docstring gains principle 4: `visibility` is a rendering hint, and an
app-only tool is still callable by anyone the policy admits. An acceptance
test pins this (an app-only tool behind `@authorize` is still denied).

### 4.3 Resources: static `meta`, `@appResource`, and `resourceContent()` (G3)

The MCP Apps spec puts `_meta.ui` on the **`resources/read` content item**.
The `resources/list` declaration in its example carries none (spec
§"UI Resource Format"). Emission follows the spec.

```ts
@resource('ui://bits/library', {
  mimeType: MCP_APP_MIME_TYPE,
  title: 'Parts Library',
  icons: [...],
  meta: openaiDisplayModes({preferred: 'fullscreen'}), // static content-item _meta
})
```

- **`@resource` options.** `title`, `icons` and `meta` are added. `title` and
  `icons` go on the `resources/list` entry; `meta` goes on every content item
  `resources/read` returns. The same reserved-key rules apply as in §4.1.
- **`@appResource(uri, {csp?, permissions?, domain?, prefersBorder?, meta?})`.**
  This is P1-6's sugar, now specified:
  - It fixes `mimeType` to `MCP_APP_MIME_TYPE`, requires a `ui://` URI, and
    builds a typed `_meta.ui`.
  - **Change from P1-6:** `csp` is optional. The spec requires hosts to apply
    a restrictive default CSP when it is omitted (no network, no external
    resources), so requiring it would add a ceremony and no safety.
  - `domain` takes a string or a per-request function (see below).
- **`resourceContent({text} | {blob}, {mimeType?, meta?})`** is a branded
  return value, the resource counterpart of `fileResponse`:
  - A resource method may return one or an array.
  - `blob: Uint8Array` is base64-encoded.
  - Per-call `meta` is merged over the static `meta`, with the per-call value
    winning.
  - Unbranded objects keep today's `JSON.stringify` behaviour, so nothing
    breaks. We do not sniff for `{contents}` the way `tools/call` sniffs for
    `{content}`; a brand cannot collide with a resource whose real payload
    has that shape.
- **Per-request `domain`.** `domain: ({client}) => string | undefined`
  receives the per-request client info from §4.5. This is how one server
  hands Claude its hashed domain and ChatGPT its own (open question Q4).

### 4.4 Server identity and capability contributions (G4)

```ts
new MCPApplication({
  mcp: {
    name: 'bits-and-bolts',
    title: 'Bits & Bolts',
    icons: [{src: LOGO_SVG, mimeType: 'image/svg+xml'}],
    websiteUrl: 'https://bits.example.com',
    capabilities: {extensions: {'acme/feature': {}}}, // static, rarely needed
  },
});
```

- **`MCPServerConfig` additions.** It gains `title`, `icons`, `websiteUrl`
  (the 2025-11-25 `Implementation` fields) and
  `capabilities?: {extensions?, experimental?}`. `tools`, `resources` and
  `prompts` stay framework-owned and cannot be overridden.
- **Contributions.** A new extension point, `MCP_CAPABILITIES`, takes bindings
  whose value is `{extensions?, experimental?}`. Installers contribute through
  it, so `installOpenAISettings` can advertise `openai/settings` without the
  app editing its config, **and `uninstall()` retracts it** by unbinding (the
  revertible-installs contract).
- **One resolver, `resolveCapabilities()`,** merges config and contributions.
  The same key from two sources throws, naming both bindings, unless the
  values are deep-equal. Both construction sites call it.
- **Construction timing:**
  - **`buildServer` (HTTP, both eras).** It resolves on every build. Under the
    stateless default that is per request, so a contribution added or
    retracted takes effect on the next request.
  - **stdio.** `this.mcp` is constructed in the `MCPServer` constructor,
    before any contributor is bound. Capabilities move to `start()`
    (`server.registerCapabilities(...)` before `connect`). A connected stdio
    session keeps what it negotiated; a retraction is visible after
    reconnect. That matches 2025-era `initialize` semantics, and the
    `2026-07-28` stdio era (`serveStdio`) builds per connection anyway.

### 4.5 Per-request client capabilities and request `_meta` (G5)

Two optional per-request bindings, set in `requestContextFor`:

- **`MCPBindings.CLIENT`:** `{capabilities, info?, era: 'legacy' | 'modern'}`.
  It is the same on both eras:
  - **modern:** `envelope[CLIENT_CAPABILITIES_META_KEY]`.
  - **legacy:** the session server's `getClientCapabilities()` /
    `getClientVersion()`.
  - **Absent** for in-process `callTool`.

  `mrtrContext` is rewritten to read it, so `confirm:` and user elicitation
  share one notion of "can this client elicit". A helper
  `hasClientExtension(client, 'openai/elicitation')` checks `extensions`, then
  falls back to `experimental`, mirroring the two places OpenAI advertises.

- **`MCPBindings.REQUEST_META`:** `request.params._meta`, frozen. Tools read
  host-supplied context such as `openai/resource` without injecting the raw
  SDK extra.

### 4.6 Tests (phase 1)

- **Emission:** `tools/list` emission (icons, annotations, merged `meta`).
- **Rejections at decoration:** a reserved key; `meta.ui`; `confirm` +
  `readOnlyHint`.
- **Resource content:** `resourceContent` with text, blob, an array, and meta
  precedence; `@appResource` `_meta.ui` on the content item and not the list
  entry.
- **Capabilities on both eras:** they appear on `initialize` (legacy) **and**
  `server/discover` (modern), over HTTP and over stdio, reusing
  `stdio-eras.integration.ts`.
- **Contribution lifecycle:** collisions throw; retraction through
  `runInstallConformance`.
- **Client info:** `MCPBindings.CLIENT` on both eras, and its absence
  in-process.

## 5. Phase 2 — user-authored elicitation (G6)

This is the one phase-1-sized gap that is not purely additive, so it gets its
own phase and review.

```ts
@tool('cad.inspect', {input: InspectIn, output: InspectOut})
async inspect(
  input: z.infer<typeof InspectIn>,
  @inject(MCPBindings.INPUT) ask: InputChannel,
): Promise<z.infer<typeof InspectOut>> {
  const {part} = await ask.elicit('part', partPickerForm);  // may suspend the call
  return this.catalog.inspect(part);                         // side effects AFTER elicit
}
```

- **`InputChannel.elicit(key, form, {method?})`.** It returns the parsed answer
  when `inputResponses[key]` is present. Otherwise it throws an internal
  `InputRequiredSignal` collecting `inputRequests[key]`. Throwing (rather than
  returning) keeps the tool's declared return type `z.infer<output>`.
- **Dispatch.**
  - `invokeTool` catches the signal and returns `inputRequired(...)` **before**
    output validation, which is the fix for `:691`.
  - `isInputRequiredResult` short-circuiting extends to any tool result, not
    just `confirm:`.
  - A declined, cancelled or malformed answer throws `AgentError`
    `elicitation_declined`, the same affirmative-answer rule `confirm:` uses.
- **Re-execution is the MRTR model.** The tool body runs again from the top
  when the client retries. The documented rule is to **elicit before side
  effects**. A `requestState` the tool needs is **sealed by the framework**
  (HMAC, the `ConfirmationStore` discipline), because `requestState` is
  echoed by the client and the spec treats it as attacker-controlled.
  Multi-instance deployments bind a shared key.
- **Per era and caller:**

  | Caller                                                       | Behaviour                                                                                                                                 |
  | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | 2026-07-28, client declared the capability                   | MRTR `input_required` (above)                                                                                                             |
  | Legacy session transport (stdio legacy, `mcp-http` sessions) | Blocking `ctx.mcpReq.send({method: method ?? 'elicitation/create', …})`; `method` lets the OpenAI adapter use `openai/elicitation/create` |
  | Legacy stateless (no server→client channel)                  | `AgentError` `elicitation_unavailable`                                                                                                    |
  | In-process `callTool` (`agents`, `command`, inspector)       | `AgentError` `elicitation_unavailable`: no human to answer. `command` TTY prompting is out of scope                                       |

- **Forms.** `form` is either a flat Zod object (the SDK lowers it and
  validates the answer) or `{requestedSchema: JsonObject, parse(content)}` for
  extended forms. The SDK strips unknown keys from Zod-lowered schemas, so
  extended forms **must** be raw JSON; the adapter's builder produces that
  pair.
- **Tests.**
  - `x-openai-*` keys survive the 2026 wire end to end, the first test
    written (Q1).
  - Each era and caller row above.
  - Forged, replayed and tampered `requestState`, reusing the shape of
    `confirm-mrtr.unit.ts`.
  - An `output:` tool that elicits.

## 6. Phase 3 — `@agentback/mcp-hosts`

One package with two subpath exports, both optional. It holds Zod schemas,
pure meta-fragment builders, and `install*` helpers built only on the phase
1–2 seams. `zod` is a peer dependency. There is no dependency on any vendor
SDK.

### 6.1 `@agentback/mcp-hosts/openai`

| Export                                                     | What it does                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openaiUi({entrypoints?, preferredModelDisplayMode?})`     | Tool `meta` fragment for `openai/ui`, Zod-validated (`file` extensions must start with `.`, `quickAction` targets carry icons)                                                                                                                                          |
| `openaiDisplayModes({preferred?, available?})`             | Resource `meta` fragment; rejects `pip`, which ChatGPT does not support                                                                                                                                                                                                 |
| `MentionSearchIn` / `MentionSearchOut`, `openaiMentions()` | Schemas for a hand-written `@tool('search_mentions', {input, output, ui: {visibility: ['app']}, meta: openaiMentions()})`                                                                                                                                               |
| `FileEntrypointIn`                                         | The `{file: {name, resourceUri}}` input schema for a file-entrypoint tool                                                                                                                                                                                               |
| `openaiForm(builder)`                                      | Typed `x-openai-input` (resource picker: `selection`, `options`, `userOptions`), `x-openai-thumbnail`, `x-openai-suggestions`, option `description`, `pattern`. Returns `{requestedSchema, parse}` for `ask.elicit(…, {method: 'openai/elicitation/create'})` on legacy |
| `resourcePath({roots})`                                    | Reads `REQUEST_META["openai/resource"].path`; **requires an absolute path under a configured root** (§8)                                                                                                                                                                |
| `installOpenAISettings(app, opts)`                         | See §6.2                                                                                                                                                                                                                                                                |
| `installOpenAI(app)`                                       | Boot-time conformance checks over every registered tool (below). Returns `Installed`                                                                                                                                                                                    |

**What `installOpenAI` checks at `app.start()`.** Each rule is a MUST in the
OpenAI spec:

- A `global` or `thread` entrypoint tool's `input:` accepts `{}`; this is a
  `standardParse` against the real schema.
- A `file` entrypoint tool's `input:` accepts a `FileEntrypointIn` sample.
- A mentions tool includes `'app'` in `ui.visibility`.
- An entrypoint tool has a `ui.resourceUri`.
- An entrypoint tool without `icons` gets a warning, not an error (the spec
  says SHOULD).

### 6.2 Settings, Zod-first

```ts
const Settings = z.object({
  units: z.enum(['mm', 'in']).meta({title: 'Measurement units'}),
  showGrid: z.boolean().meta({title: 'Show grid'}),
});

installOpenAISettings(app, {
  schema: Settings,
  defaults: {units: 'mm', showGrid: false},
  layout: [
    {
      kind: 'group',
      title: 'Display',
      items: [
        {kind: 'property', property: 'units'},
        {kind: 'tool', tool: 'cad.library', title: 'Browse parts…'},
      ],
    },
  ],
  store: new InMemorySettingsStore(), // SettingsStore port
});
```

- **One Zod object is the source of truth.**
  - The read result's `schema` is its emitted JSON Schema.
  - The update tool's input is `{set: schema.partial().strict()}` with
    `minProperties: 1`.
  - `values` is `defaults` ⊕ the stored patch, validated by the full schema
    before it is returned.
- **Install-time checks:**
  - Fields are primitives only (boolean, string or string enum, number,
    integer).
  - Every field has a `title`.
  - `defaults` parses.
  - Layout `property` references exist and appear only once.
  - Layout `tool` references name a registered tool that accepts `{}`; this
    check runs at `start()`.
- **Tools.** It registers `settings.read` (`readOnlyHint`) and
  `settings.update` through `addTool` on a generated `@mcpServer` class, and
  contributes `openai/settings` under both `extensions` and `experimental`
  (OpenAI advertises in both for 2025-era hosts). Both tools go through the
  normal `callTool` pipeline: `@authorize`, metering and output validation.
- **The store is per principal.** `SettingsStore` is
  `get(principalKey)` / `patch(principalKey, partial)`, keyed from
  `SecurityBindings.USER`. An anonymous caller shares one bucket and the
  installer warns about it at boot.
- **`uninstall()`** unbinds both tools and the capability contribution.

### 6.3 `@agentback/mcp-hosts/claude`

- **`claudeUiDomain(serverUrl)`** returns
  `sha256(serverUrl).slice(0, 32) + '.claudemcpcontent.com'`, per Claude's
  documented format. It is used in
  `@appResource({domain: ({client}) => ...})` (§4.3).
- There is nothing else today: Claude has no extension spec. The subpath
  exists so Claude conventions have an obvious home if one appears.

### 6.4 Example

Extend `examples/hello-mcp-apps` instead of adding a new example:

- a global entrypoint plus display modes on the existing widget;
- one settings group;
- a mention-search tool;
- a per-host `domain`.

It runs over `mcp-http` so it can be added as a remote connector to both
hosts. `docs/guides/mcp-apps-widgets.md` gains a "host extensions" section.

## 7. Gateway (`mcp-host`) — documented limitation, not new machinery (G7)

`mcp-host` spreads `{...tool, name}`, so upstream `_meta`, `icons` and
`annotations` already pass through. Resource contents pass through on read.
Two things break:

1. **Name references.** With prefixing on, a tool's name changes but the
   references to it inside `_meta` and capabilities do not: settings
   `readTool`/`updateTool`, layout `tool` items, preview targets, quick-action
   targets.
2. **Capabilities.** Upstream `extensions` and `experimental` capabilities are
   not aggregated, so an upstream's `openai/settings` disappears behind the
   gateway.

Decision: document both in the `mcp-host` README. Expose host-extension
servers directly or with `prefix: false`. Aggregating host capabilities
(rewriting names inside opaque `_meta`) means understanding every host's
vocabulary in the gateway, which is the coupling §3.1 keeps out of the core.
We revisit if a consumer needs it.

## 8. Security

- **`openai/resource.path` is request-supplied.** On a local server it is a
  path the host chose. On a **remote** server, anyone who can call the tool can
  supply any path. `resourcePath()` therefore requires an absolute path under
  a configured root, and has no root-less mode.
- **`requestState` is attacker-controlled** (§5). It is sealed, never trusted
  raw, which is the same rule `confirm:` already follows.
- **Visibility and entrypoints are not authorization** (§3.4). An app-only or
  settings tool is still a public tool to anyone the policy admits; that is
  pinned by an acceptance test.
- **Static `meta` is published to every caller** who can list the tool, so
  secrets never go in it. Per-caller values go through `resourceContent()`,
  which runs after `@authorize`.
- **Capability contributions from plugins** can collide but cannot override
  `tools`/`resources`/`prompts` (§4.4). This matches `plugin`'s stance:
  collisions and lifecycle are governed, capability is trusted.

## 9. Open questions

| #   | Question                                                                                                                                                                                                    | How it closes                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Do `x-openai-*` keys survive the 2026 wire through `inputRequired.elicit`? A static read of SDK 2.1.0 says yes.                                                                                             | First phase-2 test, end to end through the in-memory client                                                                                              |
| Q2  | Does the 2026 per-request envelope carry the client's `extensions` map (needed to detect `openai/elicitation`)? AgentBack reads only `.elicitation` today.                                                  | Phase-1 `MCPBindings.CLIENT` test with a client declaring an extension                                                                                   |
| Q3  | Does `@openai/mcp-extensions/app` (peers ext-apps `^1.7.5`, i.e. SDK v1) work against an ext-apps 2.x `App`? It only calls `getHostCapabilities`/`getHostContext`/`connect`/requests, but that is untested. | A widget spike in the example. Otherwise document the raw `postMessage` methods; widget code is not framework code. Do not add v1 to the lockfile for it |
| Q4  | One `ui://` resource, two hosts, two `domain` formats. Is per-request `clientInfo` reliable enough to pick one, or do servers need one resource per host?                                                   | Test against both hosts. The per-request `domain` function (§4.3) supports either answer                                                                 |
| Q5  | Claude Desktop's local bridge is reported to drop `_meta.ui` for stdio servers since ~2026-09-22 ([anthropics/claude-ai-mcp#1069](https://github.com/anthropics/claude-ai-mcp/issues/1069)).                | A host bug, not ours. Run the example remote; track the issue                                                                                            |

## 10. Out of scope

- **Distribution.** Packaging an AgentBack service as an `.mcpb` bundle
  ([`modelcontextprotocol/mcpb`](https://github.com/modelcontextprotocol/mcpb))
  or as a Claude / OpenAI plugin (both use `marketplace.json` + `skills/`,
  which `skills/agentback` already fits) is a natural `@agentback/cli`
  command. It gets a separate proposal.
- **Widget-side helpers** (deep links, `ui/message` targets, model-context
  titles and thumbnails, `openai/resources/write`, `openai/files/open`).
  These are browser code against the host bridge with no server seam. P1-6
  phase 2's typed view bridge is where they would go.
- **P1-6's `openai/outputTemplate` dual-emit.** OpenAI now builds on MCP Apps
  proper (`_meta.ui.resourceUri`), so this is superseded.
- **Plugin onboarding** (`extensions["com.openai"].onboardingSkill`). It is a
  plugin manifest field, not MCP; it belongs to the distribution proposal.
- **Hiding `visibility: ['app']` tools from `tools/list` server-side.** Hosts
  filter; a server cannot know which list a host shows to the model.

## 11. Implementation plan

1. **Phase 1 (`mcp`):** §4.1–4.5 and their tests. `mcp-inspector` displays
   annotations, icons and `_meta` (read-only). `introspection` inventory
   includes `annotations`.
2. **Phase 2 (`mcp`):** §5. Q1 is the first test written.
3. **Phase 3:** `@agentback/mcp-hosts` with `/openai` and `/claude`; extend
   `hello-mcp-apps`; the `mcp-host` README limitation; Q3/Q4 spikes.
4. **Documentation surfaces, per CLAUDE.md, landing with each phase:**
   - the package READMEs;
   - `docs/packages.md`;
   - `docs/guides/mcp-apps-widgets.md`;
   - `skills/agentback` (routing plus a reference page);
   - CLAUDE.md's package list.
