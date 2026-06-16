// hello-mcp-apps — the MCP Apps widget view (the iframe content).
//
// Uses the OFFICIAL @modelcontextprotocol/ext-apps `App` bridge — this is what
// a conformant host (Claude Desktop / Goose / VS Code) speaks. A hand-rolled
// raw-postMessage widget renders BLANK in real hosts: they drive a versioned
// `ui/initialize` handshake through this bridge, not bare JSON-RPC.
//
// Bundled by src/server.ts (esbuild) and inlined into the ui:// HTML resource.
import {App} from '@modelcontextprotocol/ext-apps';

const statusEl = () => document.getElementById('status');
const forecastEl = () => document.getElementById('forecast');

// Render a CallToolResult's structuredContent — the shape get_forecast's
// `output:` schema declares (so the widget always has typed data to bind).
function render(result) {
  const data = result && result.structuredContent;
  if (!data || !data.location) {
    statusEl().textContent = 'no forecast data in tool result';
    return;
  }
  statusEl().textContent = `${data.location.name} · ${data.temperature_unit}`;
  forecastEl().innerHTML =
    '<div class="days">' +
    data.days
      .map(
        d =>
          `<div class="day"><div class="d">${d.date}</div>` +
          `<div>${d.condition}</div>` +
          `<div class="t">${Math.round(d.temperature_max)}° / ${Math.round(
            d.temperature_min,
          )}°</div></div>`,
      )
      .join('') +
    '</div>';
}

const app = new App({name: 'hello-mcp-apps-view', version: '0.0.1'});

// Register handlers BEFORE connect() so the host's initiating-tool result
// (pushed right after the handshake) is not missed.
app.ontoolresult = params => render(params);

document.getElementById('refresh').addEventListener('click', async () => {
  statusEl().textContent = 'refreshing…';
  try {
    render(
      await app.callServerTool({
        name: 'get_forecast',
        arguments: {city: 'Berlin', days: 3},
      }),
    );
  } catch (err) {
    statusEl().textContent = `refresh failed: ${err?.message ?? err}`;
  }
});

// connect() defaults to PostMessageTransport(window.parent, …) and runs the
// ui/initialize handshake.
app.connect().catch(err => {
  statusEl().textContent = `connect failed: ${err?.message ?? err}`;
});
