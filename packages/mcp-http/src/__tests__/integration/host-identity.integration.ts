// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {RestApplication, type RestServer} from '@agentback/rest';
import {extensionFor} from '@agentback/core';
import {
  MCP_SERVERS,
  MCPComponent,
  MCPServer,
  mcpServer,
  tool,
} from '@agentback/mcp';
import {installMcpHttp} from '../../index.js';

// P1-7 phase 1a (docs/proposals/host-extensions.md §4.9): what a host reads
// about the SERVER — title, icons, extension capabilities — must reach both
// protocol eras on the stateless mount, where every request builds its own
// server. And a duplicate tool a `perSession` binder contributes must never
// fail that per-request build: the app-level tool is served.

const ICON = {src: 'https://example.test/icon.svg', mimeType: 'image/svg+xml'};
const EXTENSIONS = {'com.example/widgets': {version: '1'}};

@mcpServer()
class AppTools {
  @tool('which')
  which() {
    return 'app';
  }
}

@mcpServer()
class SessionTools {
  @tool('which')
  which() {
    return 'session';
  }
}

describe('host identity over the stateless mount', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  async function start(opts: {perSessionDuplicate?: boolean} = {}) {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'identity',
      version: '1.2.3',
      title: 'Identity Server',
      icons: [ICON],
      websiteUrl: 'https://example.test',
      capabilities: {extensions: EXTENSIONS},
      transports: {stdio: false},
    });
    app.service(AppTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {
      protocol: 'both',
      ...(opts.perSessionDuplicate
        ? {
            perSession: ctx => {
              ctx
                .bind('services.SessionTools')
                .toClass(SessionTools)
                .apply(extensionFor(MCP_SERVERS));
            },
          }
        : {}),
    });
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

  it.each([
    ['2025-era initialize', false, 'legacy'],
    ['2026 server/discover', true, 'modern'],
  ])(
    'reports title, icons and extensions to a %s client',
    async (_l, modern, era) => {
      await start();
      const client = await connect(modern);
      expect(client.getProtocolEra()).toBe(era);
      expect(client.getServerVersion()).toMatchObject({
        name: 'identity',
        version: '1.2.3',
        title: 'Identity Server',
        icons: [ICON],
        websiteUrl: 'https://example.test',
      });
      expect(client.getServerCapabilities()?.extensions).toEqual(EXTENSIONS);
      await client.close();
    },
  );

  it('carries server info on a 2026 result _meta', async () => {
    await start();
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-method': 'tools/list',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {name: 'c', version: '0'},
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const json = raw.trimStart().startsWith('{')
      ? raw
      : raw
          .split('\n')
          .find(l => l.startsWith('data:'))!
          .slice(5)
          .trim();
    const msg = JSON.parse(json) as {
      result: {_meta?: Record<string, {title?: string}>};
    };
    expect(
      msg.result._meta?.['io.modelcontextprotocol/serverInfo']?.title,
    ).toBe('Identity Server');
  });

  it('serves the app tool when a perSession binder contributes a duplicate', async () => {
    await start({perSessionDuplicate: true});
    for (const modern of [true, false]) {
      const client = await connect(modern);
      const {tools} = await client.listTools();
      expect(tools.filter(t => t.name === 'which')).toHaveLength(1);
      const res = await client.callTool({name: 'which', arguments: {}});
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(res.content)).toContain('app');
      await client.close();
    }
  });
});
