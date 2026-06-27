// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {MCP_APP_MIME_TYPE} from '../../keys.js';
import {mcpServer, resource, tool} from '../../decorators/index.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';

// SEP-1865 "MCP Apps": a tool links a ui:// widget via `_meta.ui.resourceUri`,
// and the widget HTML is served by a @resource with the mcp-app MIME type. The
// widget renders the tool result's `structuredContent`. This mirrors the
// standalone render-gate probe that a real host (Claude Desktop) rendered.
const ForecastInput = z.object({city: z.string()});
const ForecastOutput = z.object({
  location: z.object({name: z.string()}),
  days: z.array(z.object({date: z.string(), condition: z.string()})),
});

const UI_URI = 'ui://weather/forecast';

@mcpServer()
class WeatherTools {
  @tool('get_forecast', {
    input: ForecastInput,
    output: ForecastOutput,
    ui: {resourceUri: UI_URI, visibility: ['model', 'app']},
  })
  getForecast(
    input: z.infer<typeof ForecastInput>,
  ): z.infer<typeof ForecastOutput> {
    return {
      location: {name: input.city},
      days: [{date: '2026-06-16', condition: 'Sunny'}],
    };
  }

  // A plain tool with no ui: — must NOT carry _meta.ui.
  @tool('ping')
  ping() {
    return 'pong';
  }

  @resource(UI_URI, {name: 'forecast-widget', mimeType: MCP_APP_MIME_TYPE})
  forecastWidget() {
    return '<!doctype html><html><body>widget</body></html>';
  }
}

async function makeClient(): Promise<Client> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'mcp-apps-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(WeatherTools);
  const server = await app.get<MCPServer>('servers.MCPServer');
  const sdkServer = server.buildServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await sdkServer.connect(serverTransport);
  const client = new Client({name: 'test-client', version: '0.0.0'});
  await client.connect(clientTransport);
  return client;
}

describe('MCP Apps (SEP-1865) ui: link', () => {
  it('emits _meta.ui.resourceUri + visibility on the tool entry', async () => {
    const client = await makeClient();
    const {tools} = await client.listTools();
    const forecast = tools.find(t => t.name === 'get_forecast')!;
    expect(forecast._meta).toEqual({
      ui: {resourceUri: UI_URI, visibility: ['model', 'app']},
    });
    await client.close();
  });

  it('omits _meta.ui on tools that declare no ui:', async () => {
    const client = await makeClient();
    const {tools} = await client.listTools();
    const ping = tools.find(t => t.name === 'ping')!;
    expect(ping._meta?.ui).toBeUndefined();
    await client.close();
  });

  it('serves the widget resource with the mcp-app MIME type', async () => {
    const client = await makeClient();
    const {resources} = await client.listResources();
    const widget = resources.find(r => r.uri === UI_URI)!;
    expect(widget.mimeType).toBe(MCP_APP_MIME_TYPE);

    const read = await client.readResource({uri: UI_URI});
    const content = read.contents[0] as {mimeType?: string; text?: string};
    expect(content.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(content.text).toContain('<html>');
    await client.close();
  });

  it('the linked tool returns structuredContent the widget binds to', async () => {
    const client = await makeClient();
    const result = await client.callTool({
      name: 'get_forecast',
      arguments: {city: 'Berlin'},
    });
    expect(
      (result.structuredContent as {location: {name: string}}).location.name,
    ).toBe('Berlin');
    await client.close();
  });
});
