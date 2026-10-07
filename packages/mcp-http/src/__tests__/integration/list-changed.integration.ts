// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import {afterEach, describe, expect, it} from 'vitest';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp, mountMcpHttpFetch} from '../../index.js';

// A tool class mounted or retracted at runtime (a plugin, say) must reach the
// clients already connected over HTTP. Two channels exist, one per era:
//
//   2025 sessions ──────────── sendToolListChanged() on each live session
//   2026-07-28 stateless ───── handler.notify → subscriptions/listen streams
//
// A 2025 client on the stateless mount has neither (one server per request,
// no standing stream), so it is told `listChanged: false` instead of being
// promised notifications that never come.

@mcpServer()
class BaseTools {
  @tool('base')
  base() {
    return {base: true};
  }
}

@mcpServer()
class LateTools {
  @tool('late')
  late() {
    return {late: true};
  }
}

for (const listener of ['express', 'native'] as const) {
  describe(`list_changed over HTTP (${listener} host)`, () => {
    let app: RestApplication | undefined;
    const clients: Client[] = [];
    let closeMount: (() => Promise<void>) | undefined;

    afterEach(async () => {
      for (const c of clients.splice(0)) await c.close().catch(() => {});
      await closeMount?.();
      closeMount = undefined;
      await app?.stop();
      app = undefined;
    });

    async function boot(protocol: 'legacy' | 'both') {
      app = new RestApplication(
        listener === 'native' ? {rest: {listener: 'native'}} : {},
      );
      app.configure('servers.RestServer').to({
        port: 0,
        host: '127.0.0.1',
        ...(listener === 'native' ? {listener: 'native' as const} : {}),
      });
      app.component(MCPComponent);
      app.configure('servers.MCPServer').to({
        name: 'lc-http',
        version: '0.0.0',
        transports: {stdio: false},
      });
      app.service(BaseTools);
      const mcp = await app.get<MCPServer>('servers.MCPServer');
      const server = await app.get<RestServer>('servers.RestServer');
      if (listener === 'native') {
        const handle = mountMcpHttpFetch(mcp, server, {protocol});
        closeMount = () => handle.closeAll();
      } else {
        await installMcpHttp(app, {protocol});
      }
      await app.start();
      return new URL(server.url + '/mcp');
    }

    async function connect(url: URL, modern: boolean) {
      const changes: string[][] = [];
      // A 2025 session hears an unprompted notification only on its standalone
      // GET stream, which the client opens on its own after `initialize`. With
      // no event store, a change announced before that stream exists is lost —
      // so a test resolves this when the stream is up and mutates after it.
      let streamOpen!: () => void;
      const standaloneStream = new Promise<void>(r => (streamOpen = r));
      const trackingFetch: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);
        if ((init?.method ?? 'GET') === 'GET' && res.ok) streamOpen();
        return res;
      };
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
      await client.connect(
        new StreamableHTTPClientTransport(url, {fetch: trackingFetch}),
      );
      clients.push(client);
      return {client, changes, standaloneStream};
    }

    it('notifies a 2025 session', async () => {
      const url = await boot('legacy');
      const {client, changes, standaloneStream} = await connect(url, false);
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
      await standaloneStream;

      app!.service(LateTools);
      await expect
        .poll(() => changes.at(-1), {timeout: 5000})
        .toEqual(['base', 'late']);
      app!.unbind('services.LateTools');
      await expect
        .poll(() => changes.at(-1), {timeout: 5000})
        .toEqual(['base']);
    });

    it('notifies a 2026-07-28 client through subscriptions/listen', async () => {
      const url = await boot('both');
      const {client, changes} = await connect(url, true);
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);

      app!.service(LateTools);
      await expect
        .poll(() => changes.at(-1), {timeout: 5000})
        .toEqual(['base', 'late']);
    });

    it('tells a 2025 client on the stateless mount it will not be notified', async () => {
      const url = await boot('both');
      const {client} = await connect(url, false);
      expect(client.getServerCapabilities()?.tools?.listChanged).toBe(false);
    });
  });
}
