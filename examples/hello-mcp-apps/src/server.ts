// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-mcp-apps — proves the AgentBack MCP Apps (SEP-1865) path end-to-end:
// a @tool links a ui:// widget via `ui:`, a @resource serves the widget HTML
// with the mcp-app MIME type, and a conformant host (Claude Desktop) renders
// the widget for the tool's structuredContent. Runs over stdio by default, or
// over Streamable HTTP with `--http` — the transport remote hosts (claude.ai,
// ChatGPT) connect to.
//
// The widget (widget/view.js) uses the official @modelcontextprotocol/ext-apps
// `App` bridge and is bundled with esbuild at startup, then inlined into the
// served HTML — so launching stays a plain `node dist/server.js`.

import {readFileSync} from 'node:fs';
import * as esbuild from 'esbuild';
import {z} from 'zod';
import {isMain} from '@agentback/core';
import {
  appResource,
  MCPApplication,
  MCPComponent,
  mcpServer,
  tool,
  type MCPServerConfig,
} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {RestApplication} from '@agentback/rest';

const UI_URI = 'ui://hello-mcp-apps/forecast';

const ForecastInput = z.object({
  city: z.string().min(1).max(64).describe('City name'),
  days: z.number().int().min(1).max(7).default(3).describe('Days (1-7)'),
});
const Day = z.object({
  date: z.string(),
  condition: z.string(),
  temperature_max: z.number(),
  temperature_min: z.number(),
});
const ForecastOutput = z.object({
  location: z.object({
    name: z.string(),
    latitude: z.number(),
    longitude: z.number(),
  }),
  temperature_unit: z.string(),
  days: z.array(Day),
});

// Deterministic sample so the example never depends on the network (swap in a
// live fetch via the injectable CoreBindings.FETCH seam if you want real data).
function forecast(
  input: z.infer<typeof ForecastInput>,
): z.infer<typeof ForecastOutput> {
  const base = [
    {condition: 'Partly cloudy', temperature_max: 24, temperature_min: 14},
    {condition: 'Light rain', temperature_max: 21, temperature_min: 13},
    {condition: 'Clear sky', temperature_max: 27, temperature_min: 15},
    {condition: 'Overcast', temperature_max: 22, temperature_min: 14},
    {condition: 'Showers', temperature_max: 20, temperature_min: 12},
    {condition: 'Sunny', temperature_max: 28, temperature_min: 16},
    {condition: 'Thunderstorm', temperature_max: 25, temperature_min: 15},
  ];
  return {
    location: {
      name: `${input.city} (sample)`,
      latitude: 52.52,
      longitude: 13.405,
    },
    temperature_unit: '°C',
    days: Array.from({length: input.days}, (_, i) => ({
      date: `2026-06-${String(16 + i).padStart(2, '0')}`,
      ...base[i % base.length],
    })),
  };
}

// Bundle the App-bridge view once at startup and inline it into the shell.
async function buildWidgetHtml(): Promise<string> {
  const widgetDir = new URL('../widget/', import.meta.url);
  const {outputFiles} = await esbuild.build({
    entryPoints: [new URL('view.js', widgetDir).pathname],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const shell = readFileSync(new URL('shell.html', widgetDir), 'utf8');
  return shell.replace('/*__VIEW_BUNDLE__*/', () => outputFiles[0].text);
}

const WIDGET_HTML = await buildWidgetHtml();

@mcpServer()
class WeatherTools {
  @tool('get_forecast', {
    description:
      'Get a daily weather forecast and render it as an interactive widget.',
    input: ForecastInput,
    output: ForecastOutput,
    // SEP-1865: link the tool to its widget. The host renders UI_URI for this
    // tool's results; the widget binds the result's `structuredContent`.
    ui: {resourceUri: UI_URI, visibility: ['model', 'app']},
    // A presentation hint, not authorization: the tool only reads.
    annotations: {readOnlyHint: true, openWorldHint: false},
  })
  async getForecast(
    input: z.infer<typeof ForecastInput>,
  ): Promise<z.infer<typeof ForecastOutput>> {
    return forecast(input);
  }

  // The widget HTML, served as a ui:// resource with the mcp-app MIME type so
  // conformant hosts render it in an iframe. `@appResource` also emits the
  // widget's `_meta.ui` on the content item; the view is fully inlined, so no
  // `csp` is needed — hosts then apply their restrictive default.
  @appResource(UI_URI, {
    name: 'forecast-widget',
    title: 'Forecast',
    prefersBorder: true,
  })
  forecastWidget(): string {
    return WIDGET_HTML;
  }
}

const SERVER: MCPServerConfig = {
  name: 'hello-mcp-apps',
  version: '0.0.1',
  title: 'Hello MCP Apps',
};

async function main() {
  if (process.argv.includes('--http')) {
    // Remote hosts connect over Streamable HTTP. Expose this port on a public
    // HTTPS URL (a tunnel is fine for development) and add that URL + `/mcp`
    // as a custom connector — see docs/guides/mcp-apps-widgets.md.
    const app = new RestApplication();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      ...SERVER,
      transports: {stdio: false},
    });
    app.service(WeatherTools);
    await installMcpHttp(app);
    await app.start();
    const {url} = await app.restServer;
    process.stderr.write(`hello-mcp-apps: MCP over HTTP at ${url}/mcp\n`);
    return;
  }
  const app = new MCPApplication();
  app.configure('servers.MCPServer').to(SERVER);
  app.service(WeatherTools);
  // stdio transport is on by default: every stdout write after start() must be
  // a JSON-RPC frame — log to stderr.
  await app.start();
  process.stderr.write('hello-mcp-apps: stdio transport ready\n');
}

if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`error: ${err}\n`);
    process.exit(1);
  }
}
