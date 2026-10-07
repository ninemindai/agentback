// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {Application} from '@agentback/core';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';

// Every server MCPServer builds advertises `listChanged` (the SDK defaults it
// on), so clients were promised list-change notifications nobody sent. These
// pin that a tool class mounted or retracted at runtime is announced on every
// connection that can carry it, and that a connection that cannot is told so.

const EchoIn = z.object({text: z.string()});

@mcpServer()
class BaseTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }
}

@mcpServer()
class LateTools {
  @tool('late')
  late() {
    return {late: true};
  }
}

@mcpServer()
class OtherLateTools {
  @tool('other')
  other() {
    return {other: true};
  }
}

describe('MCPServer list_changed', () => {
  let app: Application | undefined;
  const closers: (() => Promise<unknown>)[] = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) {
      await close().catch(() => {});
    }
    await app?.stop();
    app = undefined;
  });

  async function boot(protocol?: 'legacy' | 'both') {
    app = new Application();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'lc',
      version: '0.0.0',
      transports: {stdio: false},
      ...(protocol ? {protocol} : {}),
    });
    app.service(BaseTools);
    await app.start();
    return app.get<MCPServer>('servers.MCPServer');
  }

  /** Connect an in-process client through the configured `protocol`. */
  async function connect(mcp: MCPServer, modern: boolean) {
    const changes: string[][] = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const served = mcp.serveTransport(serverSide);
    closers.push(() => served.close());
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      {
        ...(modern ? {versionNegotiation: {mode: 'auto' as const}} : {}),
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_err, tools) =>
              changes.push((tools ?? []).map(t => t.name).sort()),
          },
        },
      },
    );
    await client.connect(clientSide);
    closers.push(() => client.close());
    return {client, changes};
  }

  it('signals once for a burst of mounts, and again on retraction', async () => {
    const mcp = await boot();
    let fired = 0;
    const off = mcp.onListsChanged(() => fired++);
    closers.push(async () => off());

    const late = app!.service(LateTools);
    app!.service(OtherLateTools);
    await expect.poll(() => fired, {timeout: 5000}).toBe(1);
    // Give a second, uncoalesced signal the chance to show up.
    await new Promise(r => setTimeout(r, 50));
    expect(fired).toBe(1);

    app!.unbind(late.key);
    await expect.poll(() => fired, {timeout: 5000}).toBe(2);

    off();
    app!.unbind('services.OtherLateTools');
    await new Promise(r => setTimeout(r, 50));
    expect(fired).toBe(2);
  });

  for (const protocol of ['both', 'legacy'] as const) {
    it(`notifies a 2025-era connection (protocol: '${protocol}')`, async () => {
      const mcp = await boot(protocol);
      const {client, changes} = await connect(mcp, false);
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);

      app!.service(LateTools);
      await expect
        .poll(() => changes.at(-1), {timeout: 5000})
        .toEqual(['echo', 'late']);

      app!.unbind('services.LateTools');
      await expect
        .poll(() => changes.at(-1), {timeout: 5000})
        .toEqual(['echo']);
    });
  }

  it('tells a 2026-era stdio-style connection it will not be notified', async () => {
    // `serveStdio` exposes no event bus, so a modern connection served this
    // way has no channel for list_changed; advertising it would be a lie.
    const mcp = await boot('both');
    const {client} = await connect(mcp, true);
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    expect(client.getServerCapabilities()?.prompts?.listChanged).toBe(false);
    expect(client.getServerCapabilities()?.resources?.listChanged).toBe(false);
  });
});
