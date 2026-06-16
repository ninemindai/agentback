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
> Desktop).

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

const ForecastInput = z.object({city: z.string(), days: z.number().int().min(1).max(7).default(3)});
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
  async getForecast(input: z.infer<typeof ForecastInput>): Promise<z.infer<typeof ForecastOutput>> {
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
  render((await app.callServerTool({name: 'get_forecast', arguments: {city: 'Berlin'}})).structuredContent);
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
const WIDGET_HTML = shellHtml.replace('/*__VIEW_BUNDLE__*/', () => outputFiles[0].text);
```

## What AgentBack emits

- `tools/list` carries `_meta: {ui: {resourceUri, visibility?}}` on the tool.
- `resources/list` and `resources/read` carry `mimeType: text/html;profile=mcp-app`.
- `tools/call` returns `structuredContent` (from the tool's `output:` schema),
  which the host forwards to the widget as a `ui/notifications/tool-result`.

No special server capability flag is needed — `@agentback/mcp` already
advertises `resources`, and the tool `_meta` is enough for the host to discover
the link.

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
