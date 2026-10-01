# Guide: Render a widget with MCP Apps

**MCP Apps** ([SEP-1865](https://modelcontextprotocol.io)) lets a tool ship an
interactive HTML widget that a conformant host (Claude Desktop, Goose, VS Code)
renders inline for the tool's result — instead of the host showing raw JSON. The
tool links a `ui://` resource; the host loads that resource in a sandboxed
iframe and feeds it the tool's `structuredContent`.

AgentBack expresses this with the primitives you already use — a `@tool` and a
`@resource` — plus one new option.

> Working example: [`examples/hello-mcp-apps`](../../examples/hello-mcp-apps)
> (`pnpm -F hello-mcp-apps build`, then register `dist/server.js` with Claude
> Desktop, or run `pnpm -F hello-mcp-apps start:http` for remote hosts).

## The shape

Three pieces:

1. **A tool that links a widget** — the `ui:` option on `@tool`. It is emitted
   on the `tools/list` entry as `_meta.ui.resourceUri`, telling the host which
   widget to render. Pair it with an `output:` schema so the widget has typed
   `structuredContent` to bind.
2. **A widget resource** — a `@resource` at that `ui://` URI returning the
   widget HTML, tagged with `MCP_APP_MIME_TYPE` (`text/html;profile=mcp-app`)
   so the host treats it as a renderable app, not opaque text.
3. **The widget itself** — HTML that connects to the host through the official
   [`@modelcontextprotocol/ext-apps`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
   `App` bridge.

```ts
import {z} from 'zod';
import {
  MCP_APP_MIME_TYPE,
  MCPApplication,
  mcpServer,
  resource,
  tool,
} from '@agentback/mcp';

const UI_URI = 'ui://weather/forecast';

const ForecastInput = z.object({
  city: z.string(),
  days: z.number().int().min(1).max(7).default(3),
});
const ForecastOutput = z.object({
  location: z.object({name: z.string()}),
  days: z.array(z.object({date: z.string(), condition: z.string()})),
});

@mcpServer()
class WeatherTools {
  @tool('get_forecast', {
    description: 'Get a daily forecast and render it as a widget.',
    input: ForecastInput,
    output: ForecastOutput,
    // SEP-1865: link the tool to its widget.
    ui: {resourceUri: UI_URI, visibility: ['model', 'app']},
  })
  async getForecast(
    input: z.infer<typeof ForecastInput>,
  ): Promise<z.infer<typeof ForecastOutput>> {
    return {location: {name: input.city}, days: [/* … */]};
  }

  @resource(UI_URI, {name: 'forecast-widget', mimeType: MCP_APP_MIME_TYPE})
  forecastWidget(): string {
    return WIDGET_HTML; // see "The widget" below
  }
}
```

`visibility` is optional — `'model'` lets the model reference the widget,
`'app'` lets the host surface it in the app UI; omit it to defer to host policy.

## The widget MUST use the `App` bridge

This is the one non-obvious requirement. The widget is an MCP **client** that
connects back to the host over `postMessage`, and real hosts drive a **versioned
`ui/initialize` handshake**. A hand-rolled raw-`postMessage` widget renders
**blank** — the host never completes the handshake with it. Use the official
bridge:

```js
import {App} from '@modelcontextprotocol/ext-apps';

const app = new App({name: 'weather-view', version: '1.0.0'});

// Register handlers BEFORE connect() — the host pushes the initiating tool's
// result right after the handshake, and you must not miss it.
app.ontoolresult = result => render(result.structuredContent);

// Refresh from inside the widget by calling the tool again:
document.getElementById('refresh').addEventListener('click', async () => {
  render(
    (
      await app.callServerTool({
        name: 'get_forecast',
        arguments: {city: 'Berlin'},
      })
    ).structuredContent,
  );
});

// connect() defaults to PostMessageTransport(window.parent, …) + the handshake.
app.connect();
```

Because the widget imports an npm package, it can't run as an inline `<script>`
as-is — bundle it (esbuild) and inline the bundle into the served HTML. The
example bundles its view at server startup, so launching stays a plain
`node dist/server.js`:

```ts
import * as esbuild from 'esbuild';
const {outputFiles} = await esbuild.build({
  entryPoints: ['widget/view.js'],
  bundle: true,
  format: 'esm',
  write: false,
});
const WIDGET_HTML = shellHtml.replace(
  '/*__VIEW_BUNDLE__*/',
  () => outputFiles[0].text,
);
```

## What AgentBack emits

- `tools/list` carries `_meta: {ui: {resourceUri?, visibility?}}` on the tool,
  plus `annotations` and `icons` when declared.
- `resources/list` carries the `mimeType` (`text/html;profile=mcp-app`) and any
  `title`/`icons`; `resources/read` carries the same `mimeType` and the widget's
  `_meta.ui` (`csp`, `permissions`, `domain`, `prefersBorder`) **on the content
  item** — where the MCP Apps spec puts it.
- `tools/call` returns `structuredContent` (from the tool's `output:` schema),
  which the host forwards to the widget as a `ui/notifications/tool-result`.

No special server capability flag is needed — `@agentback/mcp` already
advertises `resources`, and the tool `_meta` is enough for the host to discover
the link.

### `@appResource` — the widget resource, typed

`@appResource` is `@resource` with the MIME type fixed, a `ui://` URI required,
and the widget's `_meta.ui` built from typed options:

```ts
import {appResource} from '@agentback/mcp';

@appResource(UI_URI, {
  title: 'Forecast',
  // Origins the widget may call / load from. Omit it when the view is fully
  // inlined: hosts then apply a restrictive default (no network).
  csp: {connectDomains: ['https://api.example.com']},
  prefersBorder: true,
})
forecastWidget(): string {
  return WIDGET_HTML;
}
```

A resource method may also return `resourceContent({text} | {blob}, {mimeType?,
meta?})` items: `blob` (a `Uint8Array`) is served base64-encoded, and per-call
`meta` is merged over the decorator's static `_meta` (the `ui` object key by
key).

## Host extensions (ChatGPT, Claude)

Hosts layer their own metadata on top of MCP Apps. ChatGPT reads `openai/*`
keys ([OpenAI MCP Extensions](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)):
sidebar and thread entrypoints, display modes, structured settings, composer
@-mentions. Claude reads host conventions such as the widget `domain`. AgentBack
does not hard-code either vocabulary; it gives every `@tool`/`@resource` the
generic seams to carry them, each checked when the decorator is applied:

| Option                                    | Emitted as                                  |
| ----------------------------------------- | ------------------------------------------- |
| `@tool({icons})`                          | tool `icons` (e.g. a sidebar icon)          |
| `@tool({annotations})`                    | tool `annotations` (`readOnlyHint`, …)      |
| `@tool({ui: {visibility: ['app']}})`      | `_meta.ui.visibility` with no widget        |
| `@tool({extend: [toolFragment(...)]})`    | extra tool `_meta` keys                     |
| `@resource/@appResource({extend: [...]})` | extra content-item `_meta` keys             |
| `MCPServerConfig.title/icons/websiteUrl`  | server info                                 |
| `MCPServerConfig.capabilities`            | `capabilities.extensions` / `.experimental` |

`toolFragment({ui?, annotations?, meta?, check?})` is a reusable, self-checking
piece of tool metadata: its `check` runs against the merged options — including
the real `input:` schema — when `@tool` is applied, so a broken host rule fails
at the decorator line, not in the host. The same `_meta` key from two sources,
a reserved key (`ui`, `io.modelcontextprotocol/*`), an unprefixed key or a
non-JSON value also throws there. Every `_meta` key outside `ui` needs a vendor
prefix — `openai/ui`, `com.example/widget` — because unprefixed keys are
reserved for MCP itself.

`@appResource({csp, permissions, domain, prefersBorder})` is the resource side
of the same idea: those options become `_meta.ui.csp`, `.permissions`,
`.domain` and `.prefersBorder` on the `resources/read` content item.

`toolFragment`, `resourceFragment`, `@appResource` and `resourceContent` are
**experimental**: the host specs they serve are still moving, so their shapes
may change in a minor release.

Visibility, entrypoints and annotations are **presentation hints, never
authorization**: an `['app']`-only tool is still callable by anyone its
`@authorize` policy admits.

### Recipe: a ChatGPT sidebar entrypoint with display modes

```ts
import {z} from 'zod';
import {appResource, resourceFragment, tool, toolFragment} from '@agentback/mcp';

const Library = z.object({parts: z.array(z.string())}); // your output schema
const WIDGET_HTML = '<!doctype html>…'; // your bundled widget (see above)

// ChatGPT opens sidebar ("global") entrypoints with `{}` as the arguments.
const sidebarEntrypoint = toolFragment({
  meta: {'openai/ui': {entrypoints: [{type: 'global'}]}},
  check: ({input}) => {
    if (input && !(input as z.ZodType).safeParse({}).success) {
      throw new Error('a global entrypoint must accept {} as its input');
    }
  },
});

@tool('parts_library', {
  title: 'Parts Library',
  output: Library,
  icons: [{src: 'https://bits.example.com/library.svg', mimeType: 'image/svg+xml'}],
  annotations: {readOnlyHint: true},
  ui: {resourceUri: 'ui://bits/library'},
  extend: [sidebarEntrypoint],
})
async library(): Promise<z.infer<typeof Library>> { /* … */ }

@appResource('ui://bits/library', {
  extend: [
    resourceFragment({
      meta: {
        'openai/ui': {
          preferredDisplayMode: 'fullscreen',
          availableDisplayModes: ['inline', 'fullscreen'],
        },
      },
    }),
  ],
})
libraryWidget(): string { return WIDGET_HTML; }
```

Other `openai/*` keys follow the same pattern: a composer @-mention tool is
`ui: {visibility: ['app']}` plus
`toolFragment({meta: {'openai/extensions': {'mentions/search': {}}}})`, and
structured settings are two ordinary tools named by a capability in the server
config:

```ts
import {MCPBindings} from '@agentback/mcp';

const settings = {readTool: 'settings_read', updateTool: 'settings_update'};
app.configure(MCPBindings.SERVER).to({
  capabilities: {
    extensions: {'openai/settings': settings},
    experimental: {'openai/settings': settings}, // 2025-era ChatGPT reads this
  },
});
```

An installer that adds capabilities from code (rather than your config) uses
`contributeCapabilities(app, {extensions: {...}})`. It returns an `Installed`
whose `uninstall()` retracts the contribution. An entry that your config or
another contribution declares differently throws at the call, naming both, and
nothing is bound; `start()` re-checks the full set. Stateless HTTP
picks up a contribution on the next request; a connected stdio or session
client keeps what it negotiated.

OpenAI's extensions are new and still moving, so AgentBack ships no typed
`openai/*` helpers yet — see
[P1-7](../proposals/host-extensions.md) for the planned
`@agentback/mcp-openai`. The fragments above are the stable seam those helpers
will build on.

### Recipe: Claude's widget domain

Claude derives a widget's dedicated sandbox origin from your server URL — the
first 32 hex characters of its SHA-256, followed by `.claudemcpcontent.com`
([Claude docs](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md)).
Use the **public** URL users add in Claude (from config, not the request URL,
which is wrong behind a proxy or tunnel):

```ts
import {createHash} from 'node:crypto';

const claudeDomain = (serverUrl: string) =>
  createHash('sha256').update(serverUrl).digest('hex').slice(0, 32) +
  '.claudemcpcontent.com';

const publicUrl = process.env.PUBLIC_MCP_URL;
if (!publicUrl) throw new Error('Set PUBLIC_MCP_URL to the URL added in Claude');

@appResource(UI_URI, {domain: claudeDomain(publicUrl)})
```

The domain format is host-specific. A **string** is computed once and sent to
every host, so it assumes one public URL per process and that Claude is the
only host that needs it.

**One mount per host** removes both assumptions. Mount the endpoint once per
host, each with its own `path` and `host` hint, and give `domain` a function.
It runs on every `resources/read` (after `@authorize`) and returns `undefined`
for a host that should get its default:

```ts
await installMcpHttp(app, {path: '/mcp/claude', host: 'claude'});
await installMcpHttp(app, {path: '/mcp/chatgpt', host: 'chatgpt'});

@appResource(UI_URI, {
  domain: ({mount}) =>
    mount?.host === 'claude'
      ? claudeDomain(`${process.env.PUBLIC_ORIGIN}/mcp/claude`)
      : undefined,
})
```

The function receives `{client, mount, meta, request, context}`. Prefer
`mount` (`MCPBindings.REQUEST_MOUNT`): it is **your** configuration, and it
works on every era and transport, including a stateless 2025 request, where
the client never sent `clientInfo`. `client.info?.name`
(`MCPBindings.REQUEST_CLIENT`) and `meta` (`MCPBindings.REQUEST_META`, the
request's frozen `params._meta`) are what the client _says_ — fine for picking
a presentation, never for authorization. A per-call
`resourceContent({meta: {ui: {domain}}})` still wins over the function.

## See what you emit

- **`/mcp-inspector`** shows each tool's annotations, icons and `_meta`, each
  resource's content-item `_meta`, and the server's title and capabilities —
  check them before connecting a host.
- **`toolCostReport()`** lists `iconBytes` per tool, so a data-URI icon that
  bloats every `tools/list` shows up, and a `suppressed` list when a tool
  mounted after `start()` collides with an existing name.
  `MCPServer.toolConflicts()` returns the same list, and the inspector shows
  it as a banner.
- In a test, read `tools/list` through an in-memory MCP client (see
  [Test it](#test-it)) and assert `tool._meta['openai/ui']` directly.

## Connecting to ChatGPT / Claude

**Fastest start:** `npm create agentback my-app -- --mcp-apps` scaffolds a
hybrid app with a working widget tool, the ext-apps bridge, the HTTP mount and
Claude's `domain` read from `PUBLIC_URL`.

_Checked against Claude's connector docs and OpenAI's MCP extensions spec
(commit `900032d`) on 2026-10-01. Both hosts are moving; re-check the linked
docs if a step misbehaves._

Desktop apps can spawn a stdio server; claude.ai, ChatGPT and the mobile apps
connect to a remote **Streamable HTTP** endpoint:

1. Serve over HTTP — `installMcpHttp(app)` on a `RestApplication`
   (`pnpm -F hello-mcp-apps start:http` does this).
2. Put the port on a public **HTTPS** URL. A tunnel is fine for development:
   `cloudflared tunnel --url http://localhost:3000` (or
   `ngrok http 3000`).
3. Verify before you connect: point `/mcp-inspector` at the app, or send an
   `initialize` to the public URL —
   `curl -s https://<host>/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'`
   — and check the `serverInfo` that comes back.
4. Add `https://<host>/mcp` as a custom connector in the host — see
   [Claude's connector docs](https://claude.com/docs/connectors/building/mcp-apps/getting-started.md)
   or [OpenAI's plugin docs](https://developers.openai.com/codex/build-plugins).
5. After changing tools, refresh or reconnect the connector; hosts cache
   `tools/list`.
6. Check the host's platform support. OpenAI's spec lists file entrypoints,
   file access and composer @-mentions as **desktop-only**.

**Troubleshooting.** A blank widget usually means the widget does not connect
through the `@modelcontextprotocol/ext-apps` `App` bridge, or (on Claude) its
`domain` does not match the URL you added. A tool missing from the host after a
change usually means the host still has the old `tools/list` — reconnect.

## Test it

The wire shape is verifiable in-process with an in-memory MCP client (no host
required) — see
[`packages/mcp/src/__tests__/unit/mcp-apps.unit.ts`](../../packages/mcp/src/__tests__/unit/mcp-apps.unit.ts):
assert `tool._meta.ui.resourceUri`, the resource `mimeType`, and the tool's
`structuredContent`. To confirm rendering, register the server with Claude
Desktop and ask it to call the tool.

## Next

- [Build an MCP server](build-an-mcp-server.md) — tools, resources, prompts,
  and the inspector UI.
- [Secure MCP over HTTP](secure-mcp-over-http.md) — scope-gate the same tools
  on an authenticated transport.
