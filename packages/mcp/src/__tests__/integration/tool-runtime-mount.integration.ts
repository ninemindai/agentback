// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * REGRESSION (T8) + the additive counterpart of `tool-retraction.integration.ts`.
 *
 * A tool, resource or prompt class bound AFTER a server was built must become
 * visible to a client that is ALREADY CONNECTED, without a restart.
 *
 * The regression this pins: the first implementation baked the visible-tool map
 * at build time and exposed a `refreshSurface()` to recompute it — but pointed
 * that refresher at `this.mcp`, which under the shipped default
 * `protocol: 'both'` is never connected to any transport (`serveStdio` builds
 * one server per connection). The original test passed only because it pinned
 * `protocol: 'legacy'`. These tests use the DEFAULT protocol, so they fail
 * against a baked map however it is refreshed.
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import {Application} from '@agentback/core';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, prompt, resource, tool} from '../../decorators/index.js';

const EchoIn = z.object({text: z.string()});

@mcpServer()
class EchoTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }
}

@mcpServer()
class LateTools {
  @tool('late', {input: z.object({})})
  late(_input: Record<string, never>) {
    return {from: 'late'};
  }

  @resource('ui://late/widget', {
    name: 'late-widget',
    mimeType: 'text/html',
  })
  widget() {
    return '<p>late widget</p>';
  }

  @prompt('late-prompt', {description: 'a prompt mounted at runtime'})
  latePrompt() {
    return 'hello from a late prompt';
  }
}

/**
 * Boot with the SHIPPED DEFAULT protocol and connect a client to a server built
 * the way a real connection gets one. `buildServer()` is what `serveStdio`'s
 * factory calls per connection, so this is the live object — and, critically,
 * it is built BEFORE the late class is bound.
 */
async function bootDefaultProtocol(): Promise<{
  app: Application;
  client: Client;
}> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
    // No `protocol` key on purpose — this must exercise the default.
  });
  app.service(EchoTools);
  await app.start();
  const server = await app.get<MCPServer>('servers.MCPServer');

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const built = server.buildServer();
  await built.connect(serverTransport);
  const client = new Client({name: 'test-client', version: '0.0.0'});
  await client.connect(clientTransport);
  return {app, client};
}

describe('MCP capability bound after the server was built (default protocol)', () => {
  it('a runtime-bound TOOL is listed and callable on an open connection', async () => {
    const {app, client} = await bootDefaultProtocol();

    const before = await client.listTools();
    expect(before.tools.map(t => t.name)).toEqual(['echo']);

    app.service(LateTools);

    const after = await client.listTools();
    expect(after.tools.map(t => t.name).sort()).toEqual(['echo', 'late']);
    const result = await client.callTool({name: 'late', arguments: {}});
    expect(JSON.stringify(result)).toContain('late');

    await client.close();
    await app.stop();
  });

  it('a runtime-bound RESOURCE is listed and readable on an open connection', async () => {
    // The MCP Apps case: `@tool({ui})` points a tool at a `ui://` resource, so
    // a visible tool whose widget resource is unreachable is a broken feature,
    // not a carve-out.
    const {app, client} = await bootDefaultProtocol();

    const before = await client.listResources();
    expect(before.resources.map(r => r.uri)).not.toContain('ui://late/widget');

    app.service(LateTools);

    const after = await client.listResources();
    expect(after.resources.map(r => r.uri)).toContain('ui://late/widget');
    const read = await client.readResource({uri: 'ui://late/widget'});
    const [content] = read.contents as {mimeType?: string; text: string}[];
    expect(content.text).toContain('late widget');
    expect(content.mimeType).toBe('text/html');

    await client.close();
    await app.stop();
  });

  it('a runtime-bound PROMPT is listed and gettable on an open connection', async () => {
    const {app, client} = await bootDefaultProtocol();

    const before = await client.listPrompts();
    expect(before.prompts.map(p => p.name)).not.toContain('late-prompt');

    app.service(LateTools);

    const after = await client.listPrompts();
    expect(after.prompts.map(p => p.name)).toContain('late-prompt');
    const got = await client.getPrompt({name: 'late-prompt'});
    expect(JSON.stringify(got)).toContain('late prompt');

    await client.close();
    await app.stop();
  });

  it('retraction still works from the same derivation', async () => {
    // Addition and retraction are now one mechanism — asking the container at
    // request time — so unbinding must take all three away again.
    const {app, client} = await bootDefaultProtocol();
    const binding = app.service(LateTools);

    expect((await client.listTools()).tools.map(t => t.name)).toContain('late');
    app.unbind(binding.key);

    expect((await client.listTools()).tools.map(t => t.name)).not.toContain(
      'late',
    );
    expect(
      (await client.listResources()).resources.map(r => r.uri),
    ).not.toContain('ui://late/widget');
    expect((await client.listPrompts()).prompts.map(p => p.name)).not.toContain(
      'late-prompt',
    );

    await client.close();
    await app.stop();
  });
});
