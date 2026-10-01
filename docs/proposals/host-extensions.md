# Proposal P1-7: MCP host extensions — ChatGPT and Claude from the same contract

**Status:** Design, revised after review (2026-10-01). Not scheduled.
Phase 1a is host-neutral, has standalone value and can start now. Phase 3 (the
OpenAI adapter) is **gated** on OpenAI's spec settling (§9).
**Packages touched:**

- `mcp` — the seams;
- `mcp-http` — no API change; it binds two per-request facts;
- `agents` and `command` — projection exclusions;
- `metering` and `payments` — round-aware hooks;
- `mcp-host` — documented limitations;
- `mcp-inspector` — display;
- one gated new package, `@agentback/mcp-openai`;
- one example.

**Builds on:** [P1-6 MCP Apps](p1-6-mcp-apps.md), which this amends (§10);
[MCP `2026-07-28` stateless](mcp-2026-stateless.md), the source of the MRTR and
per-request-server constraints; and [revertible installs](revertible-installs.md).

---

## 1. Context

Two hosts now publish their own layer on top of MCP and
[MCP Apps (SEP-1865)](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

**OpenAI MCP Extensions**
([spec](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md),
`@openai/mcp-extensions` 0.1.0) is a large `openai/*` namespace:

- **Entrypoints:** sidebar, thread-tab, file-type and settings entrypoints.
- **Display modes.**
- **Structured settings:** an `openai/settings` capability naming a read tool
  and an update tool.
- **Composer @-mentions.**
- **Extended form elicitation:** `x-openai-*` keys on the requested schema.
- **File access:** `_meta["openai/resource"].path` on tool calls from a file
  entrypoint.

It is **pre-launch**. The repository has a single commit (2026-10-01), its
support table describes "expected support at DevDay launch", and it links a
_draft_ revision of MCP Apps.

**Claude** has no extension spec, only host conventions. The one that matters
is `_meta.ui.domain`: the first 32 hex characters of SHA-256(server URL) +
`.claudemcpcontent.com`
([getting started](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md)).
The MCP Apps spec makes the domain format explicitly **host-dependent**.

### Neither SDK can be dropped in

- **OpenAI's server SDK is v1.** `@openai/mcp-extensions/server` peers
  `@modelcontextprotocol/sdk ^1.29` and wraps the v1
  `McpServer.registerTool`. AgentBack runs on the v2 split packages through
  `setRequestHandler`, and v1 is not reintroduced (CLAUDE.md, "Deps and
  versioning").
- **Its schemas come with v1 attached.** They import v1 `sdk/types.js`, so the
  shapes are written fresh in Zod here.
- **Its widget half targets ext-apps 1.x.** `@openai/mcp-extensions/app` peers
  ext-apps `^1.7.5`. ext-apps `2.0.3` (used by `hello-mcp-apps`) peers SDK v2.

### What SDK 2.1.0 already provides

Verified against the package source. The column on the right is what
AgentBack does with it.

| Fact                                                                                                                                                                                                                                                        | Consequence                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `ServerCapabilities` accepts `extensions` / `experimental`; `server/discover` returns `{...capabilities}`                                                                                                                                                   | A capability added to the server shows up on both eras                                                                              |
| `serverInfo` is **not** in the discover result. On `2026-07-28` it travels as `_meta["io.modelcontextprotocol/serverInfo"]` on **every** result                                                                                                             | Server `icons` go out on every response; data-URI icons need a size warning (§4.4)                                                  |
| `Tool` accepts `icons` and `annotations`; `Implementation` accepts `icons`                                                                                                                                                                                  | No SDK change needed                                                                                                                |
| `ClientCapabilities2026Schema` includes `extensions` and `experimental`; `clientInfo` is a SHOULD and is asserted by the client                                                                                                                             | Client extension detection works on 2026 (former open question Q2, now **closed**). Client identity is a hint, never authority      |
| Modern HTTP backfills `getClientCapabilities()` per request. Stateless-legacy servers never see `initialize`, so it is `undefined` there. stdio-modern does not backfill                                                                                    | `REQUEST_CLIENT` (§4.6) reads the envelope first and treats "unknown" as a real answer                                              |
| A default-on **legacy shim** turns a returned `inputRequired` into real `elicitation/create` calls on 2025 session transports, then re-enters the same `tools/call` handler                                                                                 | Elicitation is "return `inputRequired`" on **both** eras, and the tool body re-runs on both. No hand-written `ctx.mcpReq.send` (§5) |
| `createRequestStateCodec` (HMAC, `bind` hook) plus a server-wide `requestState.verify`                                                                                                                                                                      | Sealing is the SDK's. One framework-owned verify has to accept `confirm:` tokens too (§5.3)                                         |
| `inputRequired.elicit` passes a plain-JSON `requestedSchema` through untouched, and the 2026 encoder deletes only named fields                                                                                                                              | `x-openai-*` keys should reach the wire (Q1, pinned by test)                                                                        |
| Under the default `protocol: 'both'`, stdio already serves through `serveStdio(() => this.buildServer())` (`packages/mcp/src/mcp.server.ts:1439`). Only `'legacy'` connects the constructor-built `this.mcp`; `registerCapabilities` is legal until connect | Capabilities cost **nothing extra** on stdio `'both'`. Only the `'legacy'` path needs a `registerCapabilities` call in `start()`    |

**Every gap is in AgentBack's emission layer.**

## 2. The gaps

| #   | Gap                                                                                                                                                                 | Where                                                        | Blocks                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| G1  | A `tools/list` entry is only `name`/`title`/`description`/schemas/`_meta.ui`                                                                                        | `compileTool`, `packages/mcp/src/mcp.server.ts:235`          | entrypoints, mention marker, `readOnlyHint`, sidebar icons              |
| G2  | `ToolUiMeta.resourceUri` is required                                                                                                                                | `packages/mcp/src/keys.ts:168`                               | app-only tools with no widget (mentions)                                |
| G3  | `dispatchResource` returns one `text` item, stringifies objects, and has no `_meta` or `blob`                                                                       | `packages/mcp/src/mcp.server.ts:453`                         | MCP Apps `_meta.ui` (csp, domain, prefersBorder), display modes, binary |
| G4  | Capabilities are hardcoded `{tools, resources, prompts}`; server info is `{name, version}` only                                                                     | `packages/mcp/src/mcp.server.ts:346`, `:1120`                | `openai/settings`, server icons                                         |
| G5  | No public view of client capabilities or request `_meta`                                                                                                            | `mrtrContext`, `packages/mcp/src/mcp.server.ts:723`          | capability-gated forms; `openai/resource.path`                          |
| G6  | A user tool cannot elicit; an `input_required` return from a tool with `output:` fails output validation                                                            | `packages/mcp/src/mcp.server.ts:691`                         | extended forms, any custom elicitation                                  |
| G7  | Two tools with the same name: the last one silently wins                                                                                                            | `computeVisibleTools`, `packages/mcp/src/mcp.server.ts:1172` | safe installer-generated tools (settings)                               |
| G8  | `mcp-host` keeps tool `_meta` but forwards only `{name, arguments}` on calls; prefixing renames tools that `_meta` refers to by name; upstream capabilities dropped | `packages/mcp-host/src/index.ts:230`, `:299`                 | settings / previews / file paths behind the gateway                     |

## 3. Principles

1. **The core gets host-neutral seams; host vocabulary goes in a gated
   adapter.** The `openai/*` vocabulary lives only in `@agentback/mcp-openai`.
   Claude's single convention is a documented recipe until a second one
   appears (§8.2).
2. **One source of truth, enforced at decoration.**
   - A host rule is checked by the fragment that introduces it, when `@tool` is
     applied. There is no opt-in `install` step to forget.
   - A settings schema's `.default()` _is_ the default.
   - `confirm:` implies `destructiveHint`.
3. **Static by default, dynamic by a branded return.** Compiled tool entries
   stay frozen and cached per (class, method). Per-request variation goes
   through `resourceContent()`, the counterpart of `fileResponse`.
4. **Host hints are not authorization.** Visibility, entrypoints and
   `readOnlyHint` change presentation only. `@authorize` and `scope` decide
   access.
5. **Client-asserted facts are hints.** `clientInfo` and declared capabilities
   choose a _presentation_ (a form, a domain), never a permission.
6. **Every new `install*` returns `Installed`** and retracts with
   `revertOwned`.

## 4. Phase 1 — host-neutral core seams (`@agentback/mcp`)

Phase **1a** (§4.1–4.5) has standalone value: it unblocks every
`_meta`/capability shape by hand, including MCP Apps `csp`/`domain`, which
`hello-mcp-apps` cannot declare today. Phase **1b** (§4.6–4.7) adds the dynamic
pieces once settings or a per-host domain has a consumer.

### 4.1 `@tool`: `icons`, `annotations`, and `extend` fragments (G1)

```ts
@tool('cad_library', {
  output: Library,
  title: 'Parts Library',
  icons: [{src: 'https://bits.example.com/icons/library.svg', mimeType: 'image/svg+xml'}],
  annotations: {readOnlyHint: true},
  ui: {resourceUri: 'ui://bits/library'},
  extend: [openai.globalEntrypoint()], // a fragment, from @agentback/mcp-openai
})
async library(): Promise<z.infer<typeof Library>> { … }
```

- **Types.** `icons?: Icon[]` and
  `annotations?: Omit<ToolAnnotations, 'title'>` are type re-exports from
  `@modelcontextprotocol/server`. `title` stays the single title source.
- **`extend?: ToolFragment[]`** is the only way to add arbitrary `_meta`.
  - A `ToolFragment` is a branded
    `{ui?, annotations?, meta?, check?(resolved)}`.
  - A raw fragment is `toolFragment({meta: {...}})`, the escape hatch for
    hand-written host keys today.
- **Merge rules, applied at decoration:**
  - `ui.visibility` is the union.
  - A second `ui.resourceUri` that differs throws.
  - Conflicting `annotations` values throw.
  - The same top-level `meta` key from two fragments throws.
  - `meta.ui` and keys under `io.modelcontextprotocol/` throw: `_meta.ui` comes
    from `ui:` and the fragments' `ui`, and the reserved namespace belongs to
    the spec.
- **Checks.** Each fragment's `check` runs at decoration against the
  **resolved** options, including the real `input:` schema. That is what
  allows "a global entrypoint must accept `{}`" to fail at the `@tool` line.
  There is no `mergeMeta` and no `installOpenAI`.
- **Copies.** Author objects (`meta`, `icons`, `ui.visibility`) are
  `structuredClone`d at decoration before `deepFreeze`, so a shared constant is
  never frozen in place (today `ui.visibility` is,
  `packages/mcp/src/mcp.server.ts:249`).
- **Derived annotations:**
  - `confirm:` sets `destructiveHint: true`.
  - `confirm:` with `readOnlyHint: true` throws.
  - Release note: this changes `tools/list` for existing `confirm:` tools.
- **Cost.** `toolCostReport` gains an `iconBytes` column; `_meta` is excluded
  from the token estimate.
- **Error format** follows the existing slot-0 guard:
  `@tool('<name>') on <Class>.<method>: <rule>. <fix>.` For example,
  `@tool('cad_library') on Cad.library: openai global entrypoint requires input: to accept {} — "q" is required. Make it .optional() or drop the entrypoint.`

### 4.2 `ToolUiMeta.resourceUri` becomes optional (G2)

`ui: {visibility: ['app']}` with no widget becomes valid.

- **Release note.** It is a public type change: readers get
  `string | undefined`, including the emission at `:249`, the inspector and
  `introspection`.
- **Not authorization (principle 4).** The docstring says `visibility` is a
  rendering hint, and an acceptance test pins that an app-only tool behind
  `@authorize` is still denied.
- **Projection.** `@agentback/agents` and `@agentback/command` exclude
  app-only tools from projection: those are model- and operator-facing
  surfaces, which is exactly what `'app'`-only opts out of.

### 4.3 Resources: `title`, `icons`, `meta`, `@appResource`, `resourceContent()` (G3)

The MCP Apps spec places `_meta.ui` on the **`resources/read` content item**;
the `resources/list` declaration carries none.

- **`@resource` options.**
  - It gains `title` and `icons`, which go on the list entry.
  - It gains `extend?: ResourceFragment[]`, whose `meta` goes on **every**
    content item `resources/read` returns. The reserved-key rules are the same
    as §4.1.
- **`@appResource(uri, {csp?, permissions?, domain?, prefersBorder?, extend?})`:**
  - Fixes `mimeType` to `MCP_APP_MIME_TYPE`, requires a `ui://` URI, and builds
    a typed `_meta.ui`.
  - `csp` is optional, because the spec mandates a restrictive default when it
    is absent (§10).
  - `domain` is a string or `(req: {client?: RequestClient}) => string | undefined`.
    A throwing function is logged at warn and the domain omitted: the widget
    still renders on the host's default origin, which is better than failing
    the read. `client` is `undefined` in-process.
- **`resourceContent({text} | {blob: Uint8Array}, {mimeType?, meta?})`** is a
  branded return value:
  - A method may return one or an array.
  - `blob` is base64-encoded.
  - Per-call `meta` wins over the fragments' `meta`.
  - Unbranded returns keep today's behaviour. Nothing sniffs for `{contents}`.
- **Release note.** The public `readResource()` return type widens to
  `text | blob` (`:426`); the inspector's resource card must handle blobs.

### 4.4 Server identity and static capabilities (G4)

```ts
new MCPApplication({
  mcp: {
    name: 'bits-and-bolts',
    title: 'Bits & Bolts',
    icons: [
      {src: 'https://bits.example.com/logo.svg', mimeType: 'image/svg+xml'},
    ],
    websiteUrl: 'https://bits.example.com',
    capabilities: {
      extensions: {
        'openai/settings': {
          readTool: 'settings_read',
          updateTool: 'settings_update',
        },
      },
    },
  },
});
```

- **`MCPServerConfig` additions:** `title`, `icons`, `websiteUrl` and
  `capabilities?: {extensions?, experimental?}`. The allowed keys are enforced
  at runtime too, so `tools`/`resources`/`prompts` cannot be overridden.
- **Where they apply.** Both construction sites read them. On stdio `'both'`
  and every HTTP mount that happens through `buildServer`. On stdio `'legacy'`,
  `start()` calls `registerCapabilities` before `connect`.
- **Icon size.** A server icon is sent on **every** 2026 result, so a data-URI
  server icon over ~1 KB warns at boot. Prefer `https` URLs.

### 4.5 Duplicate tool names are a boot error (G7)

`computeVisibleTools` keys tools by name, so a duplicate silently shadows. The
fix is a duplicate check at `start()` and in `buildServer` that throws, naming
both bindings. Installer-generated tools (§8.3) make this load-bearing.

### 4.6 Phase 1b — capability contributions

- **Extension point.** `MCP_CAPABILITIES` takes bindings whose value is
  `{extensions?, experimental?}`. **They must be constant (`.to()`).**
  `buildServer` is synchronous, and the session paths call `.connect` on its
  return directly (`packages/mcp-http/src/index.ts:704`, `fetch.ts:437`), so
  contributions are read with `getSync`. A provider or async binding throws at
  boot.
- **Resolution.** `resolveCapabilities()` merges config and contributions. The
  same key from two sources throws, naming both, unless the values are
  deep-equal. Its cost is one `find` beside the existing ones; `buildServer`
  is ~0.1 ms at 100 tools ([stateless proposal](mcp-2026-stateless.md)).
- **Retraction.** `uninstall()` retracts through `revertOwned`, so a third
  party's shadowing binding is never deleted. A connected stdio session keeps
  what it negotiated; stateless HTTP sees the change on the next request.

### 4.7 Phase 1b — `REQUEST_CLIENT` and `REQUEST_META` (G5)

These follow the `REQUEST_AUTH` / `REQUEST_INFO` / `REQUEST_EXTRA` naming.

- **`MCPBindings.REQUEST_CLIENT`:** `{era, capabilities?, info?, canRoundTrip}`.
  - Capabilities come from the 2026 envelope first, then
    `getClientCapabilities()`. `undefined` means **unknown**, not "none".
  - `canRoundTrip` is bound by the transport: true for 2026, legacy sessions
    and stdio, false for stateless-legacy.
  - `hasClientExtension(client, id)` checks `extensions`, then `experimental`.
- **`MCPBindings.REQUEST_META`:** `request.params._meta`, frozen.
- **`mrtrContext` keeps an explicit `era === 'modern'` gate.** Reading
  `REQUEST_CLIENT` on legacy sessions would turn `confirm:`'s documented 2025
  token dance into an SDK-shim elicitation, a behaviour change this proposal
  does not make.

### 4.8 Inspector and docs

These land with 1a: the docs are what make the seams usable.

- **Inspector.** `mcp-inspector` shows tool annotations, icons and `_meta`,
  server capabilities, and the **content-item** `_meta` of a `resources/read`.
- **Docs.** `docs/guides/mcp-apps-widgets.md` gains a "Host extensions" recipe.
  It contains:
  - hand-written `openai/ui` entrypoint and display-mode fragments, and an
    `openai/settings` capability;
  - Claude's domain snippet (§8.2);
  - a **"Connecting to ChatGPT / Claude" checklist**: public HTTPS or a tunnel,
    developer mode / custom connector, how to refresh tools, and which
    features are Desktop-only per OpenAI's support table.
- **Example.** `hello-mcp-apps` runs over `mcp-http`, not only stdio (see
  Q5).

### 4.9 Tests (phase 1)

| Seam                                          | Extend                                                           | New cases                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| icons, annotations, `extend` merge and checks | `decorators.unit.ts`, `mcp-apps.unit.ts`                         | each merge conflict throws; reserved keys; `confirm` + `readOnlyHint`; a shared author constant is not frozen                 |
| compile cache                                 | `tool-compile-cache.unit.ts`                                     | a cache hit preserves the merged `_meta`                                                                                      |
| `resourceContent` / `@appResource`            | `mcp-apps.unit.ts`                                               | text, blob, array; meta precedence; `_meta.ui` on the content item and not the list entry; `domain()` throws → omitted        |
| capabilities and serverInfo                   | `stdio-eras.integration.ts`, `mcp-http/stateless.integration.ts` | `'both'` and `'legacy'` stdio; `initialize` and `server/discover`; serverInfo icons in 2026 result `_meta`; bad keys rejected |
| duplicate names                               | `mcp-server.unit.ts`                                             | throws at `start()` and in `buildServer`                                                                                      |
| contributions (1b)                            | `mcp-http/uninstall.integration.ts`, `runInstallConformance`     | async binding rejected; collision; `revertOwned` keeps a shadow                                                               |
| `REQUEST_CLIENT` (1b)                         | `mcp-http/request-info.integration.ts`, `request-extras.unit.ts` | 2026 extension detection; stateless-legacy is unknown; stdio-modern; absent in-process                                        |

## 5. Phase 2 — user-authored elicitation (G6)

### 5.1 API

```ts
@tool('cad_inspect', {input: InspectIn, output: InspectOut})
async inspect(
  input: z.infer<typeof InspectIn>,
  @inject(MCPBindings.ELICIT) elicit: Elicitor,
): Promise<z.infer<typeof InspectOut>> {
  const {part} = await elicit.ask('part', {
    standard: PartChoice,              // flat Zod object: every client that can elicit
    extended: openai.partPicker(opts), // optional; only to clients declaring openai/elicitation
  });
  return this.catalog.inspect(part);   // side effects AFTER every ask
}
```

- **`ask(key, form)`.** It returns the answer when it is present (from this
  round or an earlier one, §5.3). Otherwise it records a pending request on the
  request context and throws an `InputRequired` signal; `isInputRequired(e)`
  is exported.
- **`askAll({a: formA, b: formB})`** batches several questions into one round.
- **Choosing a form.** `extended` is sent only when
  `hasClientExtension(client, 'openai/elicitation')`. Otherwise `standard` is
  sent. With no `standard`, a client that can't take the extended form gets
  `AgentError` `elicitation_unsupported`. OpenAI's own spec makes clear that
  unsupported forms are "not partially displayed".
- **No custom method.** There is no `openai/elicitation/create` option. OpenAI
  requires MRTR for registered servers, and the legacy method serves only
  direct connections.
- **Binding.** `MCPBindings.ELICIT` has an **app-level default** that throws
  `elicitation_unavailable` on use, like `PROGRESS`'s no-op default, so
  injection never fails before the defined behaviour applies.

### 5.2 Dispatch

`invokeTool` catches the signal **before** output validation (the fix at
`:691`) and branches on `REQUEST_CLIENT`:

| Caller                                                                 | Behaviour                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026, client declared `elicitation`                                    | return `inputRequired({inputRequests, requestState})`                                                                                                                                             |
| 2025 session transport or stdio                                        | the same return; the SDK legacy shim performs the `elicitation/create` round trip and re-enters the handler                                                                                       |
| 2026 without `elicitation`, stateless-legacy, or in-process `callTool` | `AgentError` `elicitation_unavailable`, decided by the framework **before** the SDK, which would otherwise raise a protocol error (`MissingRequiredClientCapability`) or a non-envelope `isError` |

The tool body **re-runs from the top on every era**. The documented rule is to
ask before side effects; §5.4 makes violations loud.

### 5.3 State, sealing, and `confirm:`

- **Answers accumulate.** A retry carries only the latest round's
  `inputResponses`. Without accumulation, `ask('a')` then `ask('b')` loses `a`
  on round 3, re-asks it, and loops until the round cap. Earlier answers
  therefore ride in sealed `requestState`.
- **One envelope, one verify.** Sealing uses the SDK's
  `createRequestStateCodec`. Its `requestState.verify` is **server-wide**, so
  it would reject `confirm:`'s raw `ConfirmationStore` token. The fix is one
  framework-owned envelope, `{confirm?, answers?, tool, inputFingerprint}`, and
  one verify for both. The tool name and an input fingerprint go in the
  payload, because the codec's `bind` sees only the request context.
  `ConfirmationStore` remains the single-use authority for confirmation; the
  envelope only carries the token. The envelope's `confirm?` field is the
  **modern-era** carrier. On legacy sessions `confirm:` keeps the
  `confirmationToken` input property (§4.7), so both statements hold, each for
  its own era.
- **`confirm:` composes with elicitation.** Both share the envelope, so round 3
  of a confirm-then-ask tool still carries the confirmation. The `confirm` key
  is reserved: `ask('confirm', …)` throws.
- **Key.** It is shared by every instance (`MCPBindings.REQUEST_STATE_KEY`,
  random per process by default). Multi-instance deployments must bind one.

### 5.4 Guards

- **Swallowed signal.** A tool that returns, or throws something else, while a
  request is pending throws:
  `@tool('cad_inspect') on Cad.inspect: elicit.ask('part') suspended the call but the tool swallowed the signal — rethrow errors where isInputRequired(e).`
- **Duplicate key.** A duplicate `ask` key within one call throws.
- **Ask after streaming.** An `ask` after a stream tool has emitted progress
  throws, because items would otherwise be re-sent on every round.
- **Testing the re-run.** `createTestApp({mcp: {era: 'modern'}})` drives MRTR
  end to end. This is the only way an in-process test sees the second run,
  since `callTool` refuses elicitation.

### 5.5 Rounds and the cross-cutting hooks

Every round re-runs `@authorize`, dispatch hooks, the rate limiter (each
modern round is a new POST) and the price gate. `confirm:` already has this
property today. The decision:

- **`McpDispatchInfo` gains `inputRequired: boolean`** on the after-hook.
- **Metering** emits usage only for the **final** round, the call that
  produced a result.
- **The price gate** verifies payment proof on every round (idempotent) and
  settles nothing until the final one.
- **The rate limiter** debits every round, because each is real traffic. This
  is documented.

### 5.6 Projection

`@agentback/agents` and `@agentback/command` exclude any tool whose method
injects `MCPBindings.ELICIT` (via `describeInjectedArguments`, at projection
time). They already do this for `confirm:` tools.

### 5.7 Tests (phase 2)

All of these are in `confirm-mrtr.unit.ts`, `stream-tools.unit.ts`,
`dispatch-hooks.unit.ts`, a new `elicit.integration.ts` over both eras, and the
agents and command projection tests:

- the Q1 wire test (`x-openai-*` survives) first;
- each row of the §5.2 table;
- multi-step accumulation and `askAll`;
- `confirm:` combined with `ask`, the reserved key, and verify accepting
  confirm tokens;
- forged, replayed and tampered envelopes;
- the swallowed signal, ask-after-yield and duplicate-key guards;
- metering billing only the final round;
- projection exclusion.

## 6. Settings, host-neutral core with an OpenAI projection

The settings concept (schema, per-principal store, read and update tools) is
not OpenAI-specific. If MCP or Claude standardizes settings, the work should
survive. The API is therefore host-neutral. It **ships inside
`@agentback/mcp-openai`** while OpenAI is its only consumer (taste decision T3)
and moves out unchanged if a second host appears.

```ts
const Settings = z.object({
  units: z.enum(['mm', 'in']).default('mm').meta({title: 'Measurement units'}),
  showGrid: z.boolean().default(false).meta({title: 'Show grid'}),
});

installSettings(app, {
  schema: Settings,
  store: new RedisSettingsStore(redis), // required; InMemorySettingsStore warns
  layout: [
    {
      kind: 'group',
      title: 'Display',
      items: [
        {kind: 'property', property: 'units'}, // typed as keyof z.infer<typeof Settings>
        {kind: 'tool', tool: 'cad_library', title: 'Browse parts…'},
      ],
    },
  ],
  advertise: ['openai'], // contributes openai/settings (extensions + experimental)
});
```

### 6.1 The schema is the single source

- **Defaults.** Every field's `.default()` is its default, and a field without
  one throws at install. `default` is stripped from the emitted settings
  schema, which OpenAI's `SettingSchema` does not allow.
- **Field rules.** Primitive fields only, every field has a `title`, and
  layout property keys are type-checked and unique.
- **Tool references.** Layout `tool` references must name a registered tool
  that accepts `{}`; this is checked at `start()`.

### 6.2 Tools

- **Names.** `settings_read` and `settings_update` by default, configurable
  through `names`. The underscore form matters: dotted names fail
  `@agentback/agents`' `TOOL_NAME_RE` (`packages/agents/src/host-tools.ts:25`),
  and §4.5 turns a clash with a user tool into a boot error.
- **Read tool.** `readOnlyHint`. It **declares an `outputSchema`** and accepts
  `{}`, both MUSTs in OpenAI's spec, and both checked.
- **Update tool.** Its input is `{set: schema.partial().strict()}` with
  `minProperties: 1`. It returns the full `values`.
- **Registration.** Both tools are generated `@mcpServer` classes registered
  through `addTool`, and go through the normal pipeline (`@authorize` via the
  `authorize` option, metering, output validation).
- **Retraction.** `uninstall()` retracts both tools and the capability through
  `revertOwned`.

### 6.3 Per-principal identity

This is the critical review finding. `authInfoToPrincipals` synthesizes
`securityId = authInfo.clientId` when a token carries no user
(`packages/mcp/src/policy.ts:43`). For ChatGPT or Claude that is the **host's**
client id, shared by every one of its users. Keying settings on that would let
every user read and overwrite everyone's settings.

- **Provenance is marked where it is decided.** `authInfoToPrincipals` tags
  the `UserProfile` it synthesizes from `clientId` as synthesized (a
  framework-owned marker). Settings reads that mark instead of comparing
  strings.
- **Default `principalKey`.** It uses only a verified subject: a `user` the
  authentication strategy supplied via `extra.user`. For a synthesized
  principal or an anonymous caller, `settings_update` **refuses** with
  `AgentError` `settings_identity_required`, and `settings_read` returns
  defaults.
- **Opt-ins.** `principalKey: (user, auth) => string` overrides the default.
  `shared: true` is an explicit opt-in to one bucket for single-user
  deployments. There is no warning-only mode.

## 7. Gateway (`mcp-host`): documented limitations (G8)

`mcp-host` spreads `{...tool, name}`, so `_meta`, `icons` and `annotations`
pass through on listing. Four things break:

1. **Request `_meta` is dropped.** Calls forward only `{name, arguments}`
   (`packages/mcp-host/src/index.ts:299`), so `openai/resource.path` never
   reaches the upstream.
2. **Upstream `input_required` is not relayed**, so an upstream that elicits
   cannot complete through the gateway.
3. **Prefixing renames tools** that `_meta` and capabilities refer to by name:
   settings tool names, layout `tool` items, previews, quick actions.
4. **Upstream `extensions` / `experimental` capabilities are not aggregated.**

Decision: document all four in the `mcp-host` README. Expose host-extension
servers directly or with `prefix: false`. Relaying `_meta` and `input_required`
is ordinary MCP and a candidate follow-up; rewriting host vocabulary inside
opaque `_meta` stays out (principle 1).

## 8. Phase 3 — `@agentback/mcp-openai` (gated)

**Gate:** start after OpenAI's spec has launched and published a release past
0.1.0 that has been stable for a few weeks. Until then the §4.1 raw fragments
and the §4.8 recipe are the hedge: authors can emit any `openai/*` key by hand
with no framework release.

### 8.1 Contents

| Export                                                                                                                                   | What it does                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai.globalEntrypoint({quickAction?})`, `.threadEntrypoint()`, `.settingsEntrypoint({searchTerms?})`, `.fileEntrypoint({extensions})` | Tool fragments. Each **checks at decoration**: `{}` accepted (global, thread, settings) or a `FileEntrypointIn` sample accepted (file); `ui.resourceUri` present; warns with no `icons` (SHOULD) |
| `openai.mentionSearch()`                                                                                                                 | Fragment adding `readOnlyHint`, `ui.visibility: ['app']` and the `mentions/search` marker; checks that the tool's input/output are `MentionSearchIn`/`MentionSearchOut`                          |
| `openai.displayModes({preferred?, available?})`                                                                                          | Resource fragment; rejects `pip`                                                                                                                                                                 |
| `openai.partPicker(…)` / `openai.form(builder)`                                                                                          | Typed `x-openai-input` (resource picker), `x-openai-thumbnail`, `x-openai-suggestions`, option `description`, `pattern`. Returns the extended half of `elicit.ask` (§5.1)                        |
| `resourcePath({roots})`                                                                                                                  | Reads `REQUEST_META["openai/resource"].path`, `realpath`s it, and requires it under a root plus separator. **Default-off on remote mounts**, where the path names the host's machine, not ours   |
| `installSettings`                                                                                                                        | §6                                                                                                                                                                                               |

The inspector gains **client profiles** ("as ChatGPT" / "as Claude") that
populate `REQUEST_CLIENT` with each host's declared capabilities, so form
selection, `domain` and capability gating are visible without deploying.

### 8.2 Claude

No package. The recipe (§4.8) documents
`sha256(serverUrl).slice(0, 32) + '.claudemcpcontent.com'` in an
`@appResource({domain})` function, keyed on `REQUEST_CLIENT.info?.name`. It
uses the **public** URL the user entered in Claude, so the value comes from
config (`PUBLIC_URL`), not from `REQUEST_INFO.url`, which is wrong behind a
proxy or tunnel.

OpenAI's spec defines no domain format, so ChatGPT gets the host default
(`undefined`). A helper is warranted once Claude has a second convention or
OpenAI defines one (taste decision T5).

## 9. Security

- **Settings identity (§6.3).** Verified subject only. The clientId fallback
  and anonymous callers cannot write. A shared bucket is opt-in.
- **`requestState` is attacker-controlled.** It is sealed with the SDK codec,
  fingerprinted to the tool and input, and verified by one framework-owned
  verify. `ConfirmationStore` stays the single-use authority for `confirm:`.
- **`openai/resource.path`.** `realpath` plus a root-and-separator check, and
  off by default on remote mounts.
- **Visibility, entrypoints and annotations are not authorization** (pinned by
  test).
- **Client-asserted facts select presentation only** (principle 5).
- **Static `meta` is public** to anyone who can list. Per-caller values go
  through `resourceContent()`, which runs after `@authorize`.
- **Capability contributions** cannot override core keys; collisions throw;
  retraction goes through `revertOwned`.
- **Duplicate tool names throw** (§4.5), so an installer cannot shadow a user
  tool.

## 10. Amends P1-6

| P1-6 said                                                                        | P1-7 decides                                                                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `visibility: ['app']` tools are omitted from the model-facing list by the server | **Hosts filter.** A server cannot know which list a host shows the model. Model-facing _projections_ we own (`agents`, `command`) do exclude them (§4.2) |
| attach `_meta.ui` only when the host advertises `io.modelcontextprotocol/ui`     | **Always emit.** Hosts ignore unknown `_meta`; capability-gating would break the per-(class, method) compile cache for no protective gain                |
| `@appResource` requires a declared CSP                                           | **Optional.** The spec mandates a restrictive default when absent, so requiring it adds a step and no safety                                             |
| phase 2: `openai/outputTemplate` dual-emit                                       | **Superseded.** OpenAI now builds on `_meta.ui.resourceUri`                                                                                              |

P1-6's header points here.

## 11. Open questions

| #   | Question                                                                                                                                                                     | How it closes                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Do `x-openai-*` keys survive the 2026 wire through `inputRequired.elicit`?                                                                                                   | First phase-2 test. If they are stripped, extended forms wait on an SDK fix (file upstream) and `standard` forms carry on                                                           |
| Q2  | ~~Does the 2026 envelope carry `extensions`?~~                                                                                                                               | **Closed: yes** (`ClientCapabilities2026Schema`)                                                                                                                                    |
| Q3  | Does `@openai/mcp-extensions/app` (ext-apps `^1.7.5`) work against an ext-apps 2.x `App`?                                                                                    | A widget spike in the example. Otherwise document the raw `postMessage` methods; never add v1 to the lockfile                                                                       |
| Q4  | Is `clientInfo` reliable enough to pick a per-host `domain`?                                                                                                                 | Test against both hosts. Fallback: one `installMcpHttp` mount per host with a host hint bound per mount; `buildServer` already runs per request, so a mount-scoped default is cheap |
| Q5  | Claude Desktop is reported to drop `_meta.ui` for stdio servers since ~2026-09-22 ([anthropics/claude-ai-mcp#1069](https://github.com/anthropics/claude-ai-mcp/issues/1069)) | A host bug; the example runs over `mcp-http`                                                                                                                                        |

## 12. Out of scope

- **Distribution.** `.mcpb` bundles
  ([`modelcontextprotocol/mcpb`](https://github.com/modelcontextprotocol/mcpb)),
  Claude and OpenAI plugin packaging (`marketplace.json` + `skills/`), OpenAI's
  `onboardingSkill`, and a `create-agentback --with mcp-apps` scaffold all
  belong in a separate distribution proposal. It should be filed after phase 1a
  lands, because that is how users of either host actually find an app.
- **Widget-side helpers** (deep links, `ui/message` targets, model-context
  titles, `openai/resources/write`, `openai/files/open`). These are browser
  code against the host bridge; they belong to P1-6 phase 2's typed view
  bridge.
- **Gateway aggregation of host vocabulary** (§7).
- **TTY prompting for elicitation in `@agentback/command`.**

## 13. Implementation plan

1. **Phase 1a (`mcp`, ship now):** §4.1–4.5 and §4.8, with the tests in §4.9.
   Release notes cover the `resourceUri` type change, `destructiveHint`
   derivation and the `readResource` return type.
2. **Phase 1b (`mcp`, `mcp-http`):** §4.6–4.7, when settings or a per-host
   domain has a consumer.
3. **Phase 2 (`mcp`, `agents`, `command`, `metering`, `payments`):** §5. Q1 is
   the first test.
4. **Phase 3 (gated, §8):** `@agentback/mcp-openai` with fragments, forms,
   `resourcePath` and `installSettings`; inspector client profiles; the
   `mcp-host` README limitations; Q3/Q4 spikes.
5. **Documentation surfaces, per CLAUDE.md, landing with each phase:**
   - the package READMEs;
   - `docs/packages.md`;
   - `docs/guides/mcp-apps-widgets.md`;
   - `skills/agentback` (routing plus a reference page);
   - CLAUDE.md's package list.

## Review record (2026-10-01)

**How it was reviewed.** Manual three-lens review: strategy and scope,
developer experience, and engineering. Each lens was an independent agent
reading the code and the SDK 2.1.0 source. `/autoplan`'s gated pipeline could
not run in the cloud session (its phase hook could not read the session
transcript), and no Codex outside voice was available.

**Corrections to the first draft:**

- stdio `'both'` already uses `buildServer`;
- `serverInfo` is not in `server/discover`;
- the SDK ships a legacy elicitation shim and a `requestState` codec;
- Q2 is closed;
- `getClientCapabilities()` is backfilled on modern HTTP and is `undefined` on
  stateless-legacy.

**Decision audit trail:**

| #   | Decision                                                                                                      | Class      | Source          |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------- | --------------- |
| 1   | Settings keyed on a verified subject only; clientId fallback and anonymous refused                            | mechanical | Eng (critical)  |
| 2   | Elicitation returns `inputRequired` on both eras via the SDK shim; framework pre-checks the unavailable cases | mechanical | Eng (SDK fact)  |
| 3   | One sealed envelope + one verify shared with `confirm:`; answers accumulate; `confirm` key reserved           | mechanical | Eng             |
| 4   | Swallowed-signal, duplicate-key, ask-after-yield guards; modern-era test switch                               | mechanical | Eng + DX        |
| 5   | Metering bills the final round; price gate settles once; limiter debits per round                             | mechanical | Eng             |
| 6   | Duplicate tool names throw; underscore tool names                                                             | mechanical | Eng             |
| 7   | Self-validating `extend` fragments at decoration; drop `installOpenAI` and `mergeMeta`                        | mechanical | DX              |
| 8   | `REQUEST_CLIENT` / `ELICIT` naming; `ELICIT` default binding throws on use                                    | mechanical | DX              |
| 9   | Standard + optional extended form chosen per client capability; no custom method                              | mechanical | CEO + DX        |
| 10  | Contributions constant + `getSync` + runtime key check + `revertOwned`                                        | mechanical | Eng             |
| 11  | Settings: `.default()` derivation, typed layout, required store, output-schema MUST, settings entrypoint      | mechanical | DX + CEO        |
| 12  | Split phase 1 into 1a / 1b; recipe and host-connection checklist in 1a                                        | mechanical | CEO             |
| 13  | Amends-P1-6 section                                                                                           | mechanical | CEO             |
| 14  | `mcp-host` documents dropped request `_meta` and `input_required`                                             | mechanical | Eng             |
| 15  | Exclude `ELICIT` and app-only tools from `agents`/`command` projection                                        | mechanical | Eng             |
| 16  | `resourcePath` realpath + separator, default-off remote                                                       | mechanical | Eng             |
| 17  | Gate phase 3 on a post-launch OpenAI spec                                                                     | taste (T2) | CEO             |
| 18  | Settings API host-neutral but shipped inside `@agentback/mcp-openai`                                          | taste (T3) | CEO vs DX       |
| 19  | Package renamed `@agentback/mcp-openai`; Claude folded into the recipe                                        | taste (T4) | CEO + DX        |
| 20  | Claude domain as a recipe, not a helper                                                                       | taste (T5) | CEO vs DX       |
| 21  | Scaffold option deferred to the distribution proposal                                                         | taste (T6) | DX vs scope     |
| 22  | Design review phase skipped: UI-term hits describe host-drawn surfaces                                        | taste (T1) | scope detection |
