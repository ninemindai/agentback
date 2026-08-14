// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {Application} from '@agentback/core';
import type {Binding} from '@agentback/context';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';

// Retraction has to be tested against a server that was built BEFORE the
// unbind: `registerAllOn` bakes a `visible` map at build time, so a server
// constructed afterwards would pass trivially and prove nothing.

const EchoIn = z.object({text: z.string()});

@mcpServer()
class EchoTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }
}

async function boot(): Promise<{
  app: Application;
  server: MCPServer;
  binding: Readonly<Binding>;
}> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  const binding = app.service(EchoTools);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server, binding};
}

/** Connect an SDK client to a server built NOW, over a paired transport. */
async function connect(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const built = server.buildServer();
  await built.connect(serverTransport);
  const client = new Client({name: 'test-client', version: '0.0.0'});
  await client.connect(clientTransport);
  return client;
}

describe('MCP tool retraction', () => {
  it('a retracted tool disappears from tools/list on a server built earlier', async () => {
    const {app, server, binding} = await boot();
    const client = await connect(server);

    const before = await client.listTools();
    expect(before.tools.map(t => t.name)).toContain('echo');

    app.unbind(binding.key);

    const after = await client.listTools();
    expect(after.tools.map(t => t.name)).not.toContain('echo');
    await client.close();
  });

  it('calling a retracted tool is not-found, not a run without DI', async () => {
    const {app, server, binding} = await boot();
    const client = await connect(server);

    const ok = await client.callTool({name: 'echo', arguments: {text: 'hi'}});
    expect(ok.isError).toBeFalsy();

    app.unbind(binding.key);

    // A retracted tool takes the SAME path as an unknown tool name: this
    // server answers tool failures as an `isError` result carrying the error
    // envelope, not as a protocol-level rejection. What matters is that it
    // did not RUN — before the liveness gate this call succeeded.
    const retracted = await client.callTool({
      name: 'echo',
      arguments: {text: 'hi'},
    });
    expect(retracted.isError).toBe(true);
    const text = (retracted.content as {type: string; text: string}[])[0].text;
    // -32602 is InvalidParams, the same code an unknown tool name yields.
    expect(JSON.parse(text).error.code).toBe(-32602);
    await client.close();
  });

  it('the programmatic path drops it too', async () => {
    const {app, server, binding} = await boot();
    expect(server.listTools().map(t => t.meta.name)).toContain('echo');

    app.unbind(binding.key);

    expect(server.listTools().map(t => t.meta.name)).not.toContain('echo');
    await expect(server.callTool('echo', {text: 'hi'})).rejects.toThrow(
      /Unknown tool/,
    );
  });

  it('resolveMember throws instead of instantiating without DI', async () => {
    const {app, server, binding} = await boot();
    // Hold a stale handle to the tool, exactly as a caller passing
    // `opts.binding` would, then retract the class behind it.
    const stale = server.listTools().find(t => t.meta.name === 'echo')!;
    app.unbind(binding.key);

    // Before this change, resolveMember fell back to `new ctor()` and this
    // call SUCCEEDED — running user code with un-injected dependencies.
    await expect(
      server.callTool('echo', {text: 'hi'}, {binding: stale}),
    ).rejects.toThrow(/not bound/i);
  });
});
