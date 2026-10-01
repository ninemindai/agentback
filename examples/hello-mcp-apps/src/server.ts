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
// ChatGPT extras via @agentback/mcp-openai: a `forecast_home` tool opens the
// same widget from ChatGPT's sidebar and thread tabs (`openaiUi`), the widget
// declares its display modes, and a temperature-unit setting appears on the
// app's settings page (`installSettings`). Over HTTP, `/mcp/claude` is a
// per-host mount whose widget gets Claude's sandbox domain.
//
// The widget (widget/view.js) uses the official @modelcontextprotocol/ext-apps
// `App` bridge and is bundled with esbuild at startup, then inlined into the
// served HTML — so launching stays a plain `node dist/server.js`.

import {createHash} from 'node:crypto';
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
import {
  displayModes,
  InMemorySettingsStore,
  installSettings,
  openaiUi,
} from '@agentback/mcp-openai';
import type {Application} from '@agentback/core';
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

// The app's settings — one Zod schema is the settings page, its defaults and
// its validation. A single shared bucket suits this local, single-user demo;
// a multi-user server keys settings per verified user (the default).
const Settings = z.object({
  unit: z
    .enum(['celsius', 'fahrenheit'])
    .default('celsius')
    .meta({title: 'Temperature unit'}),
});
const settingsStore = new InMemorySettingsStore<z.output<typeof Settings>>();

async function preferredUnit(): Promise<'celsius' | 'fahrenheit'> {
  return (await settingsStore.get('shared'))?.unit ?? 'celsius';
}

const ICON = {
  src:
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" stroke-width="1.33"/></svg>',
    ),
  mimeType: 'image/svg+xml',
};

// Claude derives a widget's sandbox origin from the URL users add.
const claudeDomain = (serverUrl: string) =>
  createHash('sha256').update(serverUrl).digest('hex').slice(0, 32) +
  '.claudemcpcontent.com';

// Deterministic sample so the example never depends on the network (swap in a
// live fetch via the injectable CoreBindings.FETCH seam if you want real data).
function forecast(
  input: z.infer<typeof ForecastInput>,
  unit: 'celsius' | 'fahrenheit' = 'celsius',
): z.infer<typeof ForecastOutput> {
  const t = (c: number) =>
    unit === 'fahrenheit' ? Math.round((c * 9) / 5 + 32) : c;
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
    temperature_unit: unit === 'fahrenheit' ? '°F' : '°C',
    days: Array.from({length: input.days}, (_, i) => {
      const day = base[i % base.length];
      return {
        date: `2026-06-${String(16 + i).padStart(2, '0')}`,
        condition: day.condition,
        temperature_max: t(day.temperature_max),
        temperature_min: t(day.temperature_min),
      };
    }),
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
    return forecast(input, await preferredUnit());
  }

  // Opened by ChatGPT from its sidebar or a thread tab, with `{}` as the
  // arguments — `openaiUi` checks at decoration that the input accepts that.
  @tool('forecast_home', {
    title: 'Forecast',
    description: 'Open the forecast widget for the home city.',
    output: ForecastOutput,
    icons: [ICON],
    ui: {resourceUri: UI_URI},
    annotations: {readOnlyHint: true, openWorldHint: false},
    extend: [openaiUi({entrypoints: [{type: 'global'}, {type: 'thread'}]})],
  })
  async forecastHome(): Promise<z.infer<typeof ForecastOutput>> {
    return forecast({city: 'Berlin', days: 3}, await preferredUnit());
  }

  // The widget HTML, served as a ui:// resource with the mcp-app MIME type so
  // conformant hosts render it in an iframe. `@appResource` also emits the
  // widget's `_meta.ui` on the content item; the view is fully inlined, so no
  // `csp` is needed — hosts then apply their restrictive default.
  @appResource(UI_URI, {
    name: 'forecast-widget',
    title: 'Forecast',
    prefersBorder: true,
    // Per request: only the `/mcp/claude` mount (and only once PUBLIC_ORIGIN
    // says where users reach it) gets Claude's domain; others get the host's
    // default sandbox.
    domain: ({mount}) =>
      mount?.host === 'claude' && process.env.PUBLIC_ORIGIN
        ? claudeDomain(`${process.env.PUBLIC_ORIGIN}/mcp/claude`)
        : undefined,
    extend: [displayModes({available: ['inline', 'fullscreen']})],
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

/** Register the tools and the settings page on either host. */
async function register(app: Application) {
  app.service(WeatherTools);
  await installSettings(app, {
    schema: Settings,
    store: settingsStore,
    shared: true,
  });
}

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
    await register(app);
    // One endpoint for any host, plus a per-host mount for Claude: the mount's
    // `host` is server configuration, so the widget domain above trusts it.
    await installMcpHttp(app);
    await installMcpHttp(app, {path: '/mcp/claude', host: 'claude'});
    await app.start();
    const {url} = await app.restServer;
    process.stderr.write(
      `hello-mcp-apps: MCP over HTTP at ${url}/mcp (Claude: ${url}/mcp/claude)\n`,
    );
    return;
  }
  const app = new MCPApplication();
  app.configure('servers.MCPServer').to(SERVER);
  await register(app);
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
