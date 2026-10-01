// The MCP Apps widget view — the HTML the host renders in an iframe.
//
// It MUST talk to the host through the official @modelcontextprotocol/ext-apps
// `App` bridge: hosts drive a versioned `ui/initialize` handshake through it,
// and a hand-rolled raw-postMessage widget renders blank. src/widget/html.ts
// bundles this file with esbuild and inlines it into widget/shell.html.
import {App} from '@modelcontextprotocol/ext-apps';

const statusEl = () => document.getElementById('status');

// Render a CallToolResult's structuredContent — the shape the tool's
// `output:` schema declares.
function render(result) {
  const data = result && result.structuredContent;
  if (!data || typeof data.greeting !== 'string') {
    statusEl().textContent = 'no greeting in tool result';
    return;
  }
  statusEl().textContent = 'from show_greeting';
  document.getElementById('greeting').textContent = data.greeting;
}

const app = new App({name: 'greeting-view', version: '0.1.0'});

// Register handlers BEFORE connect() so the result the host pushes right
// after the handshake is not missed.
app.ontoolresult = params => render(params);

document.getElementById('again').addEventListener('click', async () => {
  statusEl().textContent = 'calling…';
  try {
    render(
      await app.callServerTool({
        name: 'show_greeting',
        arguments: {name: 'world'},
      }),
    );
  } catch (err) {
    statusEl().textContent = `call failed: ${err?.message ?? err}`;
  }
});

app.connect().catch(err => {
  statusEl().textContent = `connect failed: ${err?.message ?? err}`;
});
