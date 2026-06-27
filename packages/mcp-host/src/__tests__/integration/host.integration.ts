// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {createMcpHost, mcpHostBuilder, type McpHost} from '../../index.js';

const AddIn = z.object({a: z.number().int(), b: z.number().int()});
const AddOut = z.object({sum: z.number().int()});

@mcpServer()
class UpstreamTools {
  @tool('add', {input: AddIn, output: AddOut})
  add(input: z.infer<typeof AddIn>): z.infer<typeof AddOut> {
    return {sum: input.a + input.b};
  }

  @tool('ping')
  ping() {
    return {pong: true};
  }
}

// A second upstream to prove multi-server aggregation + prefixing.
const EchoIn = z.object({text: z.string()});
@mcpServer()
class EchoUpstream {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }
}

async function startUpstream(toolClass: Function, name: string) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name,
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(toolClass as new () => object);
  await app.get<MCPServer>('servers.MCPServer');
  await installMcpHttp(app);
  await app.start();
  return {app, url: (await app.restServer).url + '/mcp'};
}

describe('mcp-host (aggregator)', () => {
  let upA: {app: RestApplication; url: string};
  let upB: {app: RestApplication; url: string};
  let host: McpHost;
  let client: Client;

  beforeEach(async () => {
    upA = await startUpstream(UpstreamTools, 'mathsrv');
    upB = await startUpstream(EchoUpstream, 'echosrv');
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    await host?.close().catch(() => {});
    await upA?.app.stop();
    await upB?.app.stop();
  });

  async function connectTo(h: McpHost) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await h.connect(serverSide);
    client = new Client({name: 'consumer', version: '0.0.0'});
    await client.connect(clientSide);
  }

  it('merges tools from multiple upstreams (prefixed) and proxies calls', async () => {
    host = await createMcpHost({
      upstreams: mcpHostBuilder()
        .http('math', upA.url)
        .http('echo', upB.url)
        .build(),
    });
    await connectTo(host);

    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['echo__echo', 'math__add', 'math__ping']);

    const sum = await client.callTool({
      name: 'math__add',
      arguments: {a: 2, b: 40},
    });
    expect(sum.structuredContent).toEqual({sum: 42});

    const echoed = await client.callTool({
      name: 'echo__echo',
      arguments: {text: 'hi'},
    });
    expect(echoed.isError).toBeFalsy();
  });

  it('preserves the upstream input schema on the merged tool', async () => {
    host = await createMcpHost({
      upstreams: [{name: 'math', transport: 'http', url: upA.url}],
    });
    await connectTo(host);
    const add = (await client.listTools()).tools.find(
      t => t.name === 'math__add',
    );
    expect(add?.inputSchema).toMatchObject({
      type: 'object',
      properties: {a: {type: 'integer'}, b: {type: 'integer'}},
    });
  });

  it('can aggregate without prefixing', async () => {
    host = await createMcpHost({
      upstreams: [{name: 'math', transport: 'http', url: upA.url}],
      prefix: false,
    });
    await connectTo(host);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['add', 'ping']);
  });

  it('errors when calling an unknown tool', async () => {
    host = await createMcpHost({
      upstreams: [{name: 'math', transport: 'http', url: upA.url}],
    });
    await connectTo(host);
    await expect(
      client.callTool({name: 'does__not__exist', arguments: {}}),
    ).rejects.toThrow();
  });
});
