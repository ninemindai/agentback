// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {RestApplication, type RestServer} from '@agentback/rest';
import {
  appResource,
  contributeCapabilities,
  MCPComponent,
  MCPServer,
  mcpServer,
} from '@agentback/mcp';
import {installMcpHttp} from '../../index.js';

// P1-7 phase 1b (docs/proposals/host-extensions.md §13): one mount per host,
// each with its own server-configured `host` hint, varies presentation (here a
// widget's sandbox domain) without trusting the client's clientInfo. And a
// capability contributed after start reaches the next stateless request.

const DOMAINS: Record<string, string> = {claude: 'abc.claudemcpcontent.com'};

@mcpServer()
class Widgets {
  @appResource('ui://w/main', {domain: ({mount}) => DOMAINS[mount?.host ?? '']})
  main() {
    return '<html></html>';
  }
}

describe.each(['express', 'native'] as const)(
  'per-host mounts (%s host)',
  listener => {
    let app: RestApplication;
    let base: string;

    async function start(protocol: 'both' | 'legacy' = 'both') {
      app = new RestApplication({rest: {listener}});
      app.configure('servers.RestServer').to({
        port: 0,
        host: '127.0.0.1',
        listener,
      });
      app.component(MCPComponent);
      app.configure('servers.MCPServer').to({
        name: 'hosts',
        version: '1.0.0',
        transports: {stdio: false},
      });
      app.service(Widgets);
      await app.get<MCPServer>('servers.MCPServer');
      const claude = await installMcpHttp(app, {
        path: '/mcp/claude',
        host: 'claude',
        protocol,
      });
      const chatgpt = await installMcpHttp(app, {
        path: '/mcp/chatgpt',
        host: 'chatgpt',
        protocol,
      });
      await app.start();
      base = (await app.get<RestServer>('servers.RestServer')).url;
      return {claude, chatgpt};
    }

    async function connect(path: string, modern = true) {
      const client = new Client(
        {name: 'same-client', version: '0'},
        modern ? {versionNegotiation: {mode: 'auto' as const}} : {},
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + path)),
      );
      return client;
    }

    async function domainVia(path: string, modern = true) {
      const client = await connect(path, modern);
      try {
        const {contents} = await client.readResource({uri: 'ui://w/main'});
        return (contents[0]._meta as {ui?: {domain?: string}} | undefined)?.ui
          ?.domain;
      } finally {
        await client.close();
      }
    }

    afterEach(async () => app?.stop());

    it.each([
      ['stateless', 'both' as const, true],
      ['stateless, 2025 client', 'both' as const, false],
      ['session', 'legacy' as const, false],
    ])(
      'serves each mount its own domain (%s)',
      async (_l, protocol, modern) => {
        await start(protocol);
        expect(await domainVia('/mcp/claude', modern)).toBe(
          'abc.claudemcpcontent.com',
        );
        expect(await domainVia('/mcp/chatgpt', modern)).toBeUndefined();
      },
    );

    it('keeps each mount advertised and retractable on its own', async () => {
      const {claude} = await start();
      expect(app.isBound('ax.sections.mcp/mcp/claude')).toBe(true);
      expect(app.isBound('ax.sections.mcp/mcp/chatgpt')).toBe(true);
      await claude.uninstall();
      expect(app.isBound('ax.sections.mcp/mcp/claude')).toBe(false);
      expect(app.isBound('ax.sections.mcp/mcp/chatgpt')).toBe(true);
      expect(await domainVia('/mcp/chatgpt')).toBeUndefined();
    });

    it('advertises a capability contributed after start on the next request', async () => {
      await start();
      const before = await connect('/mcp/claude');
      expect(before.getServerCapabilities()?.extensions).toBeUndefined();
      await before.close();

      const installed = contributeCapabilities(app, {
        extensions: {'com.example/widgets': {version: '1'}},
      });
      const during = await connect('/mcp/claude');
      expect(during.getServerCapabilities()?.extensions).toEqual({
        'com.example/widgets': {version: '1'},
      });
      await during.close();

      await installed.uninstall();
      const after = await connect('/mcp/claude');
      expect(after.getServerCapabilities()?.extensions).toBeUndefined();
      await after.close();
    });
  },
);
