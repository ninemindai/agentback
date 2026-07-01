// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createServer, request as httpRequest, type Server} from 'node:http';
import {InvalidTokenError} from '@modelcontextprotocol/server-legacy/auth';
import type {AddressInfo} from 'node:net';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {installMcpConnect, type RemoteRegistry} from '../../index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// The connect server holds a persistent MCP client (with a long-lived
// standalone SSE stream) to the upstream. In this single process the upstream,
// the connect server, the proxied client, AND the test's HTTP calls would all
// share Node's *global* undici dispatcher, where that never-ending SSE response
// starves pooled keep-alive sockets and stalls the test's own requests. So the
// test talks to the connect server over `node:http` with `agent: false` — a
// fresh, unpooled socket per call. (In production the remote MCP server is a
// separate process, so this single-process contention can't arise.)
function httpReq(
  method: string,
  url: string,
  body?: unknown,
): Promise<{status: number; json: Json}> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        agent: false, // no keep-alive pool — fresh socket per request
        headers: data
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(data),
            }
          : {},
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => (raw += c));
        res.on('end', () => {
          let json: Json;
          try {
            json = raw ? JSON.parse(raw) : undefined;
          } catch {
            json = raw; // non-JSON body (e.g. the OAuth callback's HTML page)
          }
          resolve({status: res.statusCode ?? 0, json});
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const jget = async (u: string): Promise<Json> => (await httpReq('GET', u)).json;
const jpost = async (u: string, body: unknown): Promise<Json> =>
  (await httpReq('POST', u, body)).json;

const AddIn = z.object({a: z.number().int(), b: z.number().int()});
const AddOut = z.object({sum: z.number().int()});

@mcpServer()
class UpstreamTools {
  @tool('add', {input: AddIn, output: AddOut})
  add(input: z.infer<typeof AddIn>): z.infer<typeof AddOut> {
    return {sum: input.a + input.b};
  }
}

/** Minimal OAuth AS issuing `remote-token` (see mcp-client oauth test). */
function fakeAuthServer(): Promise<{url: string; close: () => Promise<void>}> {
  let base = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const json = (o: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
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
      // RFC 7591 DCR: echo the registered client metadata (the SDK validates
      // the response against the full client schema, which requires
      // `redirect_uris`) plus an issued `client_id`.
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const meta = body ? JSON.parse(body) : {};
        json({
          ...meta,
          client_id: 'test-client',
          redirect_uris: meta.redirect_uris ?? [`${base}/callback`],
          token_endpoint_auth_method: 'none',
        });
      });
      return;
    }
    if (req.method === 'POST' && p === '/token') {
      return json({
        access_token: 'remote-token',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        url: base,
        close: () => new Promise<void>(r => server.close(() => r())),
      });
    });
  });
}

async function startUpstream(auth?: {
  tokens: string[];
  authorizationServers: string[];
}) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'upstream',
    version: '1.0.0',
    transports: {stdio: false},
  });
  app.service(UpstreamTools);
  await app.get<MCPServer>('servers.MCPServer');
  await installMcpHttp(
    app,
    auth
      ? {
          auth: {
            verifier: {
              async verifyAccessToken(token: string) {
                if (auth.tokens.includes(token))
                  return {
                    token,
                    clientId: 'c',
                    scopes: [],
                    expiresAt: Math.floor(Date.now() / 1000) + 3600,
                  };
                throw new InvalidTokenError('bad token');
              },
            },
            // Placeholder resource (port unknown pre-start); the client opts
            // out of resource validation via auth {resource: false}.
            resource: 'https://upstream.test/mcp',
            authorizationServers: auth.authorizationServers,
          },
        }
      : {},
  );
  await app.start();
  return {app, url: (await app.restServer).url + '/mcp'};
}

describe('mcp-connect (remote target manager)', () => {
  let connectApp: RestApplication;
  let registry: RemoteRegistry;
  let api: string;
  let callbackBase: string;

  beforeEach(async () => {
    connectApp = new RestApplication({});
    connectApp.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    // Tests connect to loopback upstreams, so allow private targets here; the
    // SSRF guard's default-deny behavior is covered separately below.
    registry = await installMcpConnect(connectApp, {allowPrivateTargets: true});
    await connectApp.start();
    const base = (await connectApp.restServer).url;
    api = base + '/mcp-connect/api';
    callbackBase = base + '/mcp-connect/oauth/callback';
  });
  afterEach(async () => connectApp.stop());

  // Close the connect server's persistent MCP clients BEFORE stopping an
  // upstream: those clients hold long-lived SSE streams open to it, so the
  // upstream's graceful shutdown would otherwise block waiting for them.
  const stopUpstream = async (up: {app: RestApplication}) => {
    await registry.closeAll();
    await up.app.stop();
  };

  it('connects to an unauthenticated upstream and proxies a tool call', async () => {
    const up = await startUpstream();
    try {
      const add = await jpost(`${api}/targets`, {
        url: up.url,
        auth: {type: 'none'},
      });
      expect(add.status).toBe('connected');

      const manifest = await jget(`${api}/targets/${add.id}/manifest`);
      expect(manifest.tools.map((t: {name: string}) => t.name)).toEqual([
        'add',
      ]);

      const result = await jpost(`${api}/targets/${add.id}/tools/add/call`, {
        a: 2,
        b: 40,
      });
      expect(result.structuredContent).toEqual({sum: 42});
    } finally {
      await stopUpstream(up);
    }
  });

  it('connects to a bearer-protected upstream with a token', async () => {
    const up = await startUpstream({
      tokens: ['tok'],
      authorizationServers: ['https://as'],
    });
    try {
      const add = await jpost(`${api}/targets`, {
        url: up.url,
        auth: {type: 'bearer', token: 'tok'},
      });
      expect(add.status).toBe('connected');
      const result = await jpost(`${api}/targets/${add.id}/tools/add/call`, {
        a: 1,
        b: 1,
      });
      expect(result.structuredContent).toEqual({sum: 2});
    } finally {
      await stopUpstream(up);
    }
  });

  it('runs the full OAuth flow against an upstream + AS and invokes a tool', async () => {
    const as = await fakeAuthServer();
    const up = await startUpstream({
      tokens: ['remote-token'],
      authorizationServers: [as.url],
    });
    try {
      const begin = await jpost(`${api}/targets`, {
        url: up.url,
        auth: {type: 'oauth', resource: false},
      });
      expect(begin.status).toBe('authorize');
      const state = new URL(begin.authorizationUrl).searchParams.get('state')!;
      expect(state).toBeTruthy();

      // Simulate the AS redirecting back to our callback with a code.
      const cb = await httpReq(
        'GET',
        `${callbackBase}?code=auth-code&state=${state}`,
      );
      expect(cb.status).toBe(200);

      const result = await jpost(`${api}/targets/${begin.id}/tools/add/call`, {
        a: 20,
        b: 22,
      });
      expect(result.structuredContent).toEqual({sum: 42});
    } finally {
      await stopUpstream(up);
      await as.close();
    }
  });

  it('rejects SSRF-unsafe targets by default (guard on)', async () => {
    // A registry with the default (allowPrivateTargets: false).
    const guarded = new RestApplication({});
    guarded.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    await installMcpConnect(guarded);
    await guarded.start();
    const gapi = (await guarded.restServer).url + '/mcp-connect/api';
    try {
      for (const url of [
        'http://127.0.0.1:9/mcp', // loopback
        'http://169.254.169.254/latest/meta-data/', // cloud metadata (link-local)
        'http://192.168.0.1/mcp', // RFC1918
        'file:///etc/passwd', // non-http scheme
      ]) {
        const res = await httpReq('POST', `${gapi}/targets`, {
          url,
          auth: {type: 'none'},
        });
        expect(res.status).toBe(400);
        expect(res.json.error.message).toMatch(
          /private\/reserved|http\(s\)|resolves/i,
        );
      }
    } finally {
      await guarded.stop();
    }
  });

  it('lists and removes targets', async () => {
    const up = await startUpstream();
    try {
      const add = await jpost(`${api}/targets`, {
        url: up.url,
        auth: {type: 'none'},
      });
      const listed = await jget(`${api}/targets`);
      expect(listed.map((t: {id: string}) => t.id)).toContain(add.id);
      const del = await httpReq('DELETE', `${api}/targets/${add.id}`);
      expect(del.status).toBe(204);
      expect(await jget(`${api}/targets`)).toEqual([]);
    } finally {
      await stopUpstream(up);
    }
  });
});
