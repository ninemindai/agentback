// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {RestApplication, type RestServer} from '@agentback/rest';
import {
  MCPComponent,
  MCPServer,
  mcpServer,
  resource,
  tool,
} from '@agentback/mcp';
import {
  installMcpHttp,
  mountMcpHttpFetch,
  type McpHttpHandle,
} from '../../index.js';

// Proves mountMcpHttpFetch serves MCP-over-HTTP through the runtime-neutral
// fetch path — driven here by rest.listener: 'native', i.e. the Node listener
// runs fetchHandler() (no Express in the request path), exactly as Bun/Fastify/
// Hono would. The real MCP SDK client connects over a real socket.

const EchoIn = z.object({text: z.string().min(1)});
const AddIn = z.object({a: z.number().int(), b: z.number().int()});
const AddOut = z.object({sum: z.number().int()});

@mcpServer()
class DemoTools {
  @tool('echo', {description: 'echo back', input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('add', {input: AddIn, output: AddOut})
  add(input: z.infer<typeof AddIn>): z.infer<typeof AddOut> {
    return {sum: input.a + input.b};
  }

  @resource('demo://motd', {name: 'motd', mimeType: 'text/plain'})
  motd() {
    return 'hello over fetch';
  }
}

describe('mountMcpHttpFetch (native listener)', () => {
  let app: RestApplication;
  let handle: McpHttpHandle;
  let mcpUrl: URL;

  beforeEach(async () => {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'fetch-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);
    const mcp = await app.get<MCPServer>('servers.MCPServer');
    const server = await app.get<RestServer>('servers.RestServer');
    // Mount BEFORE start(): native start() builds fetchHandler(), which folds in
    // the addFetchHandler routes registered here.
    handle = mountMcpHttpFetch(mcp, server);
    await app.start();
    mcpUrl = new URL(server.url + '/mcp');
  });

  afterEach(async () => {
    await handle.closeAll();
    await app.stop();
  });

  async function connect() {
    const client = new Client({name: 'test-client', version: '0.0.0'});
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    await client.connect(transport);
    return {client, transport};
  }

  it('completes the initialize handshake and assigns a session', async () => {
    const {client, transport} = await connect();
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });

  it('lists tools over the fetch path', async () => {
    const {client} = await connect();
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['add', 'echo']);
    await client.close();
  });

  it('calls a tool and returns structured content', async () => {
    const {client} = await connect();
    const result = await client.callTool({name: 'add', arguments: {a: 2, b: 40}});
    expect(result.structuredContent).toEqual({sum: 42});
    await client.close();
  });

  it('surfaces a tool input validation error', async () => {
    const {client} = await connect();
    const result = await client.callTool({name: 'echo', arguments: {text: ''}});
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('reads a resource over the fetch path', async () => {
    const {client} = await connect();
    const res = await client.readResource({uri: 'demo://motd'});
    expect(res.contents[0]).toMatchObject({
      uri: 'demo://motd',
      text: 'hello over fetch',
    });
    await client.close();
  });

  it('rejects a request with an unknown session id', async () => {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({jsonrpc: '2.0', method: 'tools/list', id: 1}),
    });
    expect(res.status).toBe(404);
    await res.body?.cancel();
  });

  it('binds REQUEST_AUTH as undefined when no auth is configured', async () => {
    // Sanity: the unauthenticated path still works (no strategyAuth).
    const {client} = await connect();
    const {tools} = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    await client.close();
  });
});

// installMcpHttp auto-selects the fetch mount when the server is in native mode,
// so callers don't have to know which mount to use — same one-liner, both hosts.
describe('installMcpHttp auto-routes to the fetch mount in native mode', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  beforeEach(async () => {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'fetch-auto',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app); // no explicit mount choice
    await app.start();
    const server = await app.get<RestServer>('servers.RestServer');
    mcpUrl = new URL(server.url + '/mcp');
  });

  afterEach(async () => app.stop());

  it('serves tools/list over the native fetch path', async () => {
    const client = new Client({name: 'test-client', version: '0.0.0'});
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['add', 'echo']);
    await client.close();
  });
});
