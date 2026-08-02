// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp, InMemoryEventStore} from '../../index.js';

// The 0.9.0 default flip: `protocol` unset now serves the 2026-07-28 revision
// AND 2025-era traffic from one endpoint, instead of 2025 only.
//
// Everything here is about what happens when the caller says NOTHING. The
// explicitly-configured paths are covered by stateless.integration.ts (both)
// and http.integration.ts (legacy); this file exists because a default is a
// decision too, and an untested one is just a guess about what ships.

const EchoIn = z.object({text: z.string().min(1)});

@mcpServer()
class DemoTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }
}

describe.each(['express', 'native'] as const)(
  'protocol default (%s host)',
  listener => {
    let app: RestApplication;
    let mcpUrl: URL;

    async function start(opts: Record<string, unknown> = {}) {
      app = new RestApplication({rest: {listener}});
      app.configure('servers.RestServer').to({
        port: 0,
        host: '127.0.0.1',
        listener,
      });
      app.component(MCPComponent);
      app.configure('servers.MCPServer').to({
        name: 'default',
        version: '0.0.0',
        transports: {stdio: false},
      });
      app.service(DemoTools);
      await app.get<MCPServer>('servers.MCPServer');
      await installMcpHttp(app, opts);
      await app.start();
      mcpUrl = new URL(
        (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
      );
    }

    async function connect(modern: boolean) {
      const client = new Client(
        {name: 'c', version: '0.0.0'},
        modern ? {versionNegotiation: {mode: 'auto' as const}} : {},
      );
      await client.connect(new StreamableHTTPClientTransport(mcpUrl));
      return client;
    }

    afterEach(async () => app?.stop());

    it('serves the modern era with no options at all', async () => {
      await start();
      const client = await connect(true);
      expect(client.getProtocolEra()).toBe('modern');
      const res = await client.callTool({
        name: 'echo',
        arguments: {text: 'default'},
      });
      expect(JSON.stringify(res.content)).toContain('default');
      await client.close();
    });

    it('still serves a 2025-era client with no options at all', async () => {
      // The half that makes the flip safe rather than merely new. If this ever
      // fails, the flip has become a compatibility break and must be reverted,
      // not patched.
      await start();
      const client = await connect(false);
      expect(client.getProtocolEra()).toBe('legacy');
      expect((await client.listTools()).tools.map(t => t.name)).toEqual([
        'echo',
      ]);
      await client.close();
    });

    it('mints no session id by default', async () => {
      await start();
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
      });
      expect(res.headers.get('mcp-session-id')).toBeNull();
      await res.body?.cancel();
    });

    it("protocol: 'legacy' rolls the whole thing back in one line", async () => {
      // The escape hatch has to actually work, or the flip is not reversible
      // and the two-release split buys nothing.
      await start({protocol: 'legacy'});
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {name: 'c', version: '0'},
          },
        }),
      });
      expect(res.headers.get('mcp-session-id')).toBeTypeOf('string');
      await res.body?.cancel();
    });

    it('keeps sessions when `eventStore` is set without a protocol', async () => {
      // `eventStore` is an explicit request for resumable SSE, which needs a
      // session. Rather than let the new default silently delete a capability
      // the caller named, an unset `protocol` yields to it.
      //
      // This is the same failure this codebase keeps hitting from the other
      // side: a control that is configured and quietly does nothing. Here the
      // control is the caller's, so the default gives way.
      await start({eventStore: new InMemoryEventStore()});
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {name: 'c', version: '0'},
          },
        }),
      });
      expect(res.headers.get('mcp-session-id')).toBeTypeOf('string');
      await res.body?.cancel();
    });

    it('lets an explicit protocol win over that yield, in both directions', async () => {
      // Naming the protocol is always decisive — the eventStore rule only fills
      // a gap the caller left, it never overrides a stated intent.
      await start({protocol: 'both', eventStore: new InMemoryEventStore()});
      const client = await connect(true);
      expect(client.getProtocolEra()).toBe('modern');
      await client.close();
    });
  },
);
