// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it} from 'vitest';
import {LoopbackOAuthProvider, startOAuth, finishOAuth} from '../../index.js';

const REDIRECT = 'http://localhost:9999/callback';

/**
 * A minimal OAuth 2.1 authorization server: serves RFC 9728 protected-resource
 * metadata, AS metadata, dynamic client registration, and a token endpoint —
 * enough to drive the client's discovery → DCR → PKCE → token-exchange flow.
 */
function fakeAuthServer(): Promise<{
  url: string;
  close: () => Promise<void>;
  tokenCalls: () => number;
}> {
  let base = '';
  let tokenCalls = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const json = (obj: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
    };
    const p = url.pathname;
    if (req.method === 'GET' && p.includes('oauth-protected-resource')) {
      return json({resource: `${base}/mcp`, authorization_servers: [base]});
    }
    if (
      req.method === 'GET' &&
      (p.includes('oauth-authorization-server') ||
        p.includes('openid-configuration'))
    ) {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (req.method === 'POST' && p === '/register') {
      return json({
        client_id: 'test-client',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }
    if (req.method === 'POST' && p === '/token') {
      tokenCalls++;
      return json({
        access_token: 'remote-token',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-1',
        scope: 'mcp',
      });
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as AddressInfo;
      base = `http://127.0.0.1:${port}`;
      resolve({
        url: base,
        tokenCalls: () => tokenCalls,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

describe('mcp-client OAuth (interactive flow)', () => {
  let as: Awaited<ReturnType<typeof fakeAuthServer>>;
  afterEach(async () => as?.close());

  it('startOAuth runs discovery + DCR + PKCE and yields an authorization URL', async () => {
    as = await fakeAuthServer();
    const provider = new LoopbackOAuthProvider({
      redirectUrl: REDIRECT,
      clientName: 'test',
      scope: 'mcp',
    });
    const result = await startOAuth(provider, `${as.url}/mcp`);
    expect(result.status).toBe('redirect');
    if (result.status !== 'redirect') return;
    const u = new URL(result.authorizationUrl);
    expect(u.pathname).toBe('/authorize');
    expect(u.searchParams.get('client_id')).toBe('test-client'); // from DCR
    expect(u.searchParams.get('code_challenge')).toBeTruthy(); // PKCE
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(result.state).toBeTruthy();
  });

  it('finishOAuth exchanges the authorization code for tokens', async () => {
    as = await fakeAuthServer();
    const provider = new LoopbackOAuthProvider({redirectUrl: REDIRECT});
    // start sets the registered client + PKCE verifier on the provider
    const start = await startOAuth(provider, `${as.url}/mcp`);
    expect(start.status).toBe('redirect');
    await finishOAuth(provider, `${as.url}/mcp`, 'auth-code-123');
    expect(provider.isAuthorized()).toBe(true);
    expect(provider.tokens()?.access_token).toBe('remote-token');
    expect(as.tokenCalls()).toBe(1);
  });

  it('stores the dynamically-registered client for reuse', async () => {
    as = await fakeAuthServer();
    const provider = new LoopbackOAuthProvider({redirectUrl: REDIRECT});
    await startOAuth(provider, `${as.url}/mcp`);
    expect(provider.clientInformation()?.client_id).toBe('test-client');
  });
});
