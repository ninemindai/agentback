# hello-mcp-apps

Proves the AgentBack **MCP Apps** (SEP-1865) path end-to-end: an MCP `@tool`
links an interactive `ui://` widget, a conformant host (Claude Desktop, Goose,
VS Code) renders the widget, and the widget binds the tool result's
`structuredContent`.

## The shape

Three pieces, all in [`src/server.ts`](src/server.ts):

1. **A tool that links a widget** — `@tool('get_forecast', {input, output, ui})`.
   The `ui: {resourceUri, visibility}` option is emitted on the `tools/list`
   entry as `_meta.ui`, telling the host which widget to render.
2. **A widget resource** — `@resource('ui://…', {mimeType: MCP_APP_MIME_TYPE})`
   returns the widget HTML. `MCP_APP_MIME_TYPE` is `text/html;profile=mcp-app`,
   the marker conformant hosts look for.
3. **The widget itself** — [`widget/view.js`](widget/view.js) uses the official
   `@modelcontextprotocol/ext-apps` `App` bridge (`new App(...)`,
   `app.ontoolresult = render`, `app.connect()`). It is bundled with esbuild at
   server startup and inlined into the served HTML, so launching stays a plain
   `node dist/server.js`.

> A hand-rolled raw-`postMessage` widget renders **blank** in real hosts — they
> drive a versioned `ui/initialize` handshake through the `App` bridge, not bare
> JSON-RPC. Use the bridge.

## Run it

```bash
pnpm -F hello-mcp-apps build
```

Then register it with Claude Desktop (Settings → Developer → Edit Config,
`claude_desktop_config.json`) and restart Claude:

```json
{
  "mcpServers": {
    "hello-mcp-apps": {
      "command": "node",
      "args": [
        "/absolute/path/to/agentback/examples/hello-mcp-apps/dist/server.js"
      ]
    }
  }
}
```

### Over HTTP (claude.ai, ChatGPT, mobile)

Remote hosts connect to a Streamable HTTP endpoint instead of spawning a
process:

```bash
PORT=3000 pnpm -F hello-mcp-apps start:http
# → MCP over HTTP at http://127.0.0.1:3000/mcp
```

Expose the port on a public HTTPS URL (a tunnel is fine for development) and add
`https://<host>/mcp` as a custom connector. The full checklist is in
[docs/guides/mcp-apps-widgets.md](../../docs/guides/mcp-apps-widgets.md#connecting-to-chatgpt--claude).

The same server also carries the ChatGPT extras from `@agentback/mcp-openai`:

- `forecast_home` opens the widget from ChatGPT's sidebar and thread tabs
  (`openaiUi`);
- the widget declares its display modes (`displayModes`);
- a **Temperature unit** setting appears on the app's settings page
  (`installSettings`). Over stdio it is one shared bucket for the single local
  user. Over HTTP settings are per verified user, and the demo mounts no
  auth, so updates there are refused until you add `strategyAuth`.

`/mcp/claude` is a per-host mount (`installMcpHttp({host: 'claude'})`). With
`PUBLIC_ORIGIN` set to the public origin you add in Claude, its widget gets
Claude's sandbox domain. `/mcp` keeps each host's default.

Ask Claude something like _"get the forecast for Berlin"_. It calls
`get_forecast`, and the widget renders the daily cards inline. The **Refresh**
button calls the tool again from inside the widget via `app.callServerTool(...)`.
