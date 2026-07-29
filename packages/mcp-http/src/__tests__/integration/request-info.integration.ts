// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {OAuthError, OAuthErrorCode} from '@modelcontextprotocol/server';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {inject} from '@agentback/core';
import {RestApplication, type RestServer} from '@agentback/rest';
import {
  MCPBindings,
  MCPComponent,
  MCPServer,
  mcpServer,
  tool,
  type McpRequestInfo,
} from '@agentback/mcp';
import {
  installMcpHttp,
  mountMcpHttpFetch,
  type McpHttpHandle,
} from '../../index.js';

// MCPBindings.REQUEST_INFO is what `@agentback/payments` reads the x402
// `X-PAYMENT` / `X-MPP-SESSION` headers from, and SDK v2 changed where it comes
// from: v1 handed a `RequestInfo` header record, v2 hands the Web `Request`.
// This is the only end-to-end coverage of that wiring — the payments unit test
// binds REQUEST_INFO by hand, so a transport that stopped populating it would
// leave every payment header silently unreadable with a fully green suite.
//
//   client --H: X-PAYMENT--> transport --ctx.http.req--> requestContextFor
//                                                              |
//                                                              v
//                                                  MCPBindings.REQUEST_INFO
//                                                    (the Web Request)
//
// Both hosts are covered: the Express host (NodeStreamableHTTPServerTransport,
// which converts IncomingMessage -> Web Request) and the fetch/edge host
// (WebStandardStreamableHTTPServerTransport, already Web-native).

@mcpServer()
class HeaderTools {
  @tool('headers')
  headers(
    @inject(MCPBindings.REQUEST_INFO, {optional: true})
    info?: McpRequestInfo,
  ) {
    return {
      bound: !!info,
      // Sent capitalized by the client; `Headers.get` is case-insensitive.
      payment: info?.headers.get('x-payment') ?? null,
      session: info?.headers.get('x-mpp-session') ?? null,
    };
  }
}

/** Call the `headers` tool with custom headers, return its structured result. */
async function callHeaders(mcpUrl: URL) {
  const client = new Client({name: 'test-client', version: '0.0.0'});
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: {
      headers: {'X-PAYMENT': 'pay-blob', 'x-mpp-session': 'sess-9'},
    },
  });
  await client.connect(transport);
  const res = await client.callTool({name: 'headers', arguments: {}});
  await client.close();
  return JSON.parse(
    (res.content as Array<{type: string; text: string}>)[0].text,
  ) as {bound: boolean; payment: string | null; session: string | null};
}

describe('REQUEST_INFO over the Express host', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'req-info-express',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(HeaderTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {});
    await app.start();
    const server = await app.get<RestServer>('servers.RestServer');
    mcpUrl = new URL(server.url + '/mcp');
  });

  afterEach(async () => {
    await app.stop();
  });

  it('populates REQUEST_INFO with the transport request headers', async () => {
    const out = await callHeaders(mcpUrl);
    expect(out.bound).toBe(true);
    expect(out.payment).toBe('pay-blob');
    expect(out.session).toBe('sess-9');
  });
});

describe('REQUEST_INFO over the fetch/edge host', () => {
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
      name: 'req-info-fetch',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(HeaderTools);
    const mcp = await app.get<MCPServer>('servers.MCPServer');
    const server = await app.get<RestServer>('servers.RestServer');
    handle = mountMcpHttpFetch(mcp, server);
    await app.start();
    mcpUrl = new URL(server.url + '/mcp');
  });

  afterEach(async () => {
    await handle.closeAll();
    await app.stop();
  });

  it('populates REQUEST_INFO with the transport request headers', async () => {
    const out = await callHeaders(mcpUrl);
    expect(out.bound).toBe(true);
    expect(out.payment).toBe('pay-blob');
    expect(out.session).toBe('sess-9');
  });
});

// RFC 9728 discovery is fetched cross-origin by browser-hosted MCP clients, and
// the SDK client sends a custom `MCP-Protocol-Version` header — which makes it a
// preflighted request, not a simple one. SDK v1 got the preflight answer for
// free from `metadataHandler`'s `cors()`. Serving the document by hand means
// answering OPTIONS by hand too: Express's built-in OPTIONS reply carries
// `Allow:` but no CORS headers, so the browser rejects it and discovery dies
// before the first token is ever requested.
describe('protected-resource metadata CORS preflight', () => {
  const verifier = {
    async verifyAccessToken(token: string) {
      if (token === 'good')
        return {
          token,
          clientId: 'c',
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'bad token');
    },
  };
  const PRM = '/.well-known/oauth-protected-resource';

  for (const listener of ['express', 'native'] as const) {
    describe(`${listener} host`, () => {
      let app: RestApplication;
      let base: string;

      beforeEach(async () => {
        app = new RestApplication(
          listener === 'native' ? {rest: {listener: 'native'}} : {},
        );
        app.configure('servers.RestServer').to({
          port: 0,
          host: '127.0.0.1',
          ...(listener === 'native' ? {listener: 'native'} : {}),
        });
        app.component(MCPComponent);
        app.configure('servers.MCPServer').to({
          name: 'prm',
          version: '0.0.0',
          transports: {stdio: false},
        });
        app.service(HeaderTools);
        await app.get<MCPServer>('servers.MCPServer');
        await installMcpHttp(app, {
          auth: {
            verifier,
            resource: 'http://example.test/',
            authorizationServers: ['http://as.test/'],
          },
        });
        await app.start();
        base = (await app.get<RestServer>('servers.RestServer')).url;
      });

      afterEach(async () => {
        await app.stop();
      });

      it('serves the document with an open CORS header', async () => {
        const res = await fetch(base + PRM);
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(await res.json()).toMatchObject({
          resource: 'http://example.test/',
        });
      });

      it('answers the CORS preflight', async () => {
        const res = await fetch(base + PRM, {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://client.example',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'mcp-protocol-version',
          },
        });
        expect(res.status).toBeLessThan(300);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(res.headers.get('access-control-allow-methods')).toContain(
          'GET',
        );
      });
    });
  }
});
