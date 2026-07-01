// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
import {OAuthError} from '@agentback/mcp-http';

// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {connectMcp, bearerFetch} from '../../index.js';

const AddIn = z.object({a: z.number().int(), b: z.number().int()});
const AddOut = z.object({sum: z.number().int()});

@mcpServer()
class Tools {
  @tool('add', {input: AddIn, output: AddOut})
  add(input: z.infer<typeof AddIn>): z.infer<typeof AddOut> {
    return {sum: input.a + input.b};
  }
}

const verifier = {
  async verifyAccessToken(token: string) {
    if (token === 'good')
      return {
        token,
        clientId: 'cli',
        scopes: ['mcp'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    throw new OAuthError('invalid_token', 'invalid token');
  },
};

async function startServer(opts: {auth?: boolean} = {}) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'srv',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(Tools);
  await app.get<MCPServer>('servers.MCPServer');
  await installMcpHttp(
    app,
    opts.auth
      ? {
          auth: {
            verifier,
            resource: 'https://example.test/mcp',
            authorizationServers: ['https://as.example.test'],
          },
        }
      : {},
  );
  await app.start();
  const url = (await app.restServer).url + '/mcp';
  return {app, url};
}

describe('mcp-client (connectMcp)', () => {
  let app: RestApplication;
  let url: string;
  afterEach(async () => app?.stop());

  describe('against an unauthenticated server', () => {
    beforeEach(async () => {
      ({app, url} = await startServer());
    });

    it('connects and lists/calls tools', async () => {
      const {client, transport} = await connectMcp({url, name: 'demo'});
      expect(transport.sessionId).toBeTruthy();
      const {tools} = await client.listTools();
      expect(tools.map(t => t.name)).toEqual(['add']);
      const r = await client.callTool({name: 'add', arguments: {a: 2, b: 40}});
      expect(r.structuredContent).toEqual({sum: 42});
      await client.close();
    });
  });

  describe('against an OAuth-protected server', () => {
    beforeEach(async () => {
      ({app, url} = await startServer({auth: true}));
    });

    it('authenticates with a bearer token', async () => {
      const {client} = await connectMcp({url, bearerToken: 'good'});
      const r = await client.callTool({name: 'add', arguments: {a: 1, b: 2}});
      expect(r.structuredContent).toEqual({sum: 3});
      await client.close();
    });

    it('refreshes and retries once on a 401 (expired token)', async () => {
      // First token is rejected; the getter then returns a valid one — the
      // bearerFetch 401-retry should recover transparently.
      let calls = 0;
      const getToken = () => (calls++ === 0 ? 'expired' : 'good');
      const {client} = await connectMcp({url, bearerToken: getToken});
      const r = await client.callTool({name: 'add', arguments: {a: 5, b: 5}});
      expect(r.structuredContent).toEqual({sum: 10});
      expect(calls).toBeGreaterThan(1); // proves a retry happened
      await client.close();
    });

    it('fails to connect with no token', async () => {
      await expect(connectMcp({url})).rejects.toThrow();
    });
  });

  describe('bearerFetch', () => {
    it('injects Authorization and surfaces a persistent 401', async () => {
      ({app, url} = await startServer({auth: true}));
      const f = bearerFetch('still-bad');
      const res = await f(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
      });
      expect(res.status).toBe(401);
    });
  });
});
