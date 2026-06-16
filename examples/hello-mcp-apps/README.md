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
      "args": ["/absolute/path/to/agentback/examples/hello-mcp-apps/dist/server.js"]
    }
  }
}
```

Ask Claude something like *"get the forecast for Berlin"*. It calls
`get_forecast`, and the widget renders the daily cards inline. The **Refresh**
button calls the tool again from inside the widget via `app.callServerTool(...)`.
