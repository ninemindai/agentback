# Proposal P1-6: MCP Apps — interactive tool UI from the same contract

**Status:** Design (2026-06-11). Implementation not scheduled — phase 1 is
ready to pick up; phases 2–3 want a real consumer first.
**Packages touched:** `mcp`, `mcp-inspector`, `mcp-host` (passthrough), one
new package (`@agentback/mcp-apps`), one example.

## Context: the spec is Final and the clients shipped

MCP Apps (SEP-1865) is the first official MCP extension, **Final on the
Extensions Track** with stable spec version `2026-01-26` and an official SDK
(`@modelcontextprotocol/ext-apps`, layered on the same
`@modelcontextprotocol/sdk` our `mcp` package wraps). Claude.ai, Claude
Desktop, ChatGPT (via the Apps SDK convergence), VS Code Copilot, Goose, and
Postman render it today.

Mechanics, abbreviated:

- A tool advertises a UI via `_meta.ui.resourceUri` pointing at a normal MCP
  resource with a `ui://` URI and `mimeType: 'text/html;profile=mcp-app'`.
- The host renders that HTML in a sandboxed iframe; the view speaks JSON-RPC
  over `postMessage` (`ui/initialize`, `tools/call`, `ui/notifications/
tool-result`, …) — the view is itself a constrained MCP client.
- Hosts advertise the capability as
  `capabilities.extensions['io.modelcontextprotocol/ui']` at `initialize`;
  servers degrade to text-only when it is absent.
- The data convention is the one we already implement: `content[]` is for
  the model, **`structuredContent` is for the UI**.

That last line is why this proposal exists. The `structuredContent` a view
receives is exactly the value our dispatcher validated against the tool's
`output:` schema. Every other framework hands the widget an untyped blob;
boundary coherence means we can hand it `z.infer<typeof Output>` — the same
schema, one more boundary.

References: [spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
· [overview](https://modelcontextprotocol.io/extensions/apps/overview)
· [launch post](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
· [ChatGPT divergences](https://github.com/modelcontextprotocol/ext-apps/issues/201).

## Competitive frame

FastMCP 3 ("FastMCP Apps", Python) ships prefab components and a
`@mcp.tool(app=True)` authoring story; mcp-use (TS) auto-discovers React
widget files and emits both the standard and ChatGPT metadata dialects. Both
treat the widget's data contract as untyped. Our wedge is not a component
library — it is that the tool schema types the widget.

## Design

### Phase 1 — emit the extension correctly (small, shippable now)

1. **`@tool(..., {ui})` option.**

   ```ts
   @tool('get_forecast', {
     input: ForecastIn,
     output: ForecastOut,
     ui: {resource: 'ui://weather/forecast-card', visibility: ['model', 'app']},
   })
   ```

   `registerAllOn` adds `_meta: {ui: {resourceUri, visibility}}` to the
   tool's `tools/list` entry. Tools with `visibility: ['app']` are omitted
   from the model-facing list (they exist for view→server round-trips), which
   composes with the existing scope-based visibility gating.

2. **`@appResource` decorator** — sugar over `@resource` that fixes the
   mimeType and carries the `_meta.ui` security envelope:

   ```ts
   @appResource('ui://weather/forecast-card', {
     csp: {connectDomains: [], resourceDomains: ['https://cdn.example.com']},
     prefersBorder: true,
   })
   forecastCard(): string {
     return readFileSync(new URL('./forecast-card.html', import.meta.url), 'utf8');
   }
   ```

   The CSP/permissions declaration is required, not optional — an app
   resource without a declared CSP fails at `app.start()`, consistent with
   "boundary coherence forbids undescribed boundaries."

3. **Capability gating.** The per-session `buildServer` path already exists
   for mcp-http; thread the client's `initialize` capabilities through so
   `_meta.ui` is attached only when the host advertises
   `io.modelcontextprotocol/ui`. Tools must already return meaningful
   `content[]` text (they do — it's the validated output serialized), so the
   no-UI fallback is automatic.

4. **`mcp-host` passthrough.** `ui://` resources flow through the existing
   URI routing map untouched (URIs are never prefixed). Tool `_meta.ui` is
   forwarded as-is; the collision rule already throws on duplicate URIs.
   Audit, no new machinery expected.

5. **Example: `hello-mcp-app`** — one tool + one HTML resource using
   `@modelcontextprotocol/ext-apps` (the `App` class) directly, exercised
   over mcp-http from a real client.

### Phase 2 — the typed view bridge (the differentiator)

A new package **`@agentback/mcp-apps`** (browser-safe, mirroring the
`client` package's discipline — no server runtime imports):

```ts
// view code (the widget) — imports the SAME schema module the server uses
import {typedApp} from '@agentback/mcp-apps';
import {ForecastIn, ForecastOut} from 'weather-service/schemas';

const app = await typedApp({input: ForecastIn, output: ForecastOut});
app.onToolResult(result => {
  // result: z.infer<typeof ForecastOut> — validated, not asserted
  render(result.city, result.forecast);
});
await app.callTool('get_forecast', {city: 'Oslo'}); // input type-checked
```

`typedApp` wraps `@modelcontextprotocol/ext-apps`' `App` +
`PostMessageTransport`, runs `standardParse` on `structuredContent` before
handing it to the view, and types `tools/call` arguments via `InferSchema`.
This is the schema-shared client pattern (`packages/client`) extended to the
iframe boundary — no codegen, both ends import one module.

Also in phase 2: a **ChatGPT compat option** (`ui: {openaiCompat: true}`)
that dual-emits `_meta['openai/outputTemplate']` alongside `_meta.ui` while
the divergences (ext-apps issue #201) remain.

### Phase 3 — evaluate, don't presume

- **Inspector as host**: render app iframes in `mcp-inspector` via
  `@modelcontextprotocol/ext-apps/app-bridge` (double-iframe sandbox proxy).
  Valuable for DX, but the inspector is plain DOM today — scope it once
  phase 1 has users.
- **Prefab components** (FastMCP-style DataTable/forms): explicitly not a
  goal until real consumers ask; a component library is a product, not a
  framework seam.
- Widget state/sessions: deferred in the spec itself (ext-apps #61/#62);
  follow the spec, don't invent.

## Security posture

The extension's threat surface is "server-supplied HTML in the user's
client." Phase 1 inherits the spec's containment (host-enforced CSP from the
declared `_meta.ui.csp`, sandboxed iframe, same-server-only `tools/call`)
and adds the startup-time CSP requirement above. The `@authorize` layer
already gates which tools a session can call — view-originated `tools/call`
goes through the same dispatch, so policy holds without new code. That
composition (per-tool policy × app visibility) is worth an acceptance test.

## Implementation plan (phase 1)

1. `mcp`: `ui` option on `ToolOptions`/`ToolMetadata`; `_meta.ui` emission in
   `registerAllOn` behind capability detection; `@appResource` decorator +
   startup CSP check. Unit tests against the SDK client (`initialize` with
   and without the extension capability).
2. `mcp-host`: passthrough audit + one aggregation test with a UI-bearing
   upstream.
3. `examples/hello-mcp-app` + README sections.

## Out of scope

- A hosted widget build pipeline (bundling React → HTML is the app author's
  build, not the framework's).
- Non-HTML content types (spec defers them).
- `ui/update-model-context` sugar — exposed via `REQUEST_EXTRA` escape hatch
  until a consumer shapes the API.
