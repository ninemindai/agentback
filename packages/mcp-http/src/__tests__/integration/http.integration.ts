// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {InvalidTokenError} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {inject} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {
  MCPBindings,
  MCPComponent,
  MCPServer,
  mcpServer,
  prompt,
  resource,
  tool,
} from '@agentback/mcp';
import type {AuthInfo} from '@agentback/mcp-http';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {installMcpHttp, InMemoryEventStore} from '../../index.js';

const EchoIn = z.object({text: z.string().min(1)});
const AddIn = z.object({a: z.number().int(), b: z.number().int()});
const AddOut = z.object({sum: z.number().int()});

@mcpServer()
class DemoTools {
  @tool('echo', {description: 'echo back', input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('add', {input: AddIn, output: AddOut})
  add(input: z.infer<typeof AddIn>): z.infer<typeof AddOut> {
    return {sum: input.a + input.b};
  }

  @resource('demo://motd', {name: 'motd', mimeType: 'text/plain'})
  motd() {
    return 'hello over http';
  }

  @prompt('welcome', {description: 'a welcome prompt'})
  welcome() {
    return 'Welcome!';
  }
}

@mcpServer()
class SecureTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  // Requires the `admin` scope — hidden from callers without it.
  @tool('secret', {scope: 'admin'})
  secret() {
    return {ok: true};
  }

  // Per-request identity: the authenticated AuthInfo is injectable (1.4).
  @tool('whoami')
  whoami(
    @inject(MCPBindings.REQUEST_AUTH, {optional: true})
    auth?: AuthInfo,
  ) {
    return {clientId: auth?.clientId ?? null, scopes: auth?.scopes ?? []};
  }
}

// Maps demo bearer tokens to scopes. A real verifier would validate a JWT
// against the authorization server's JWKS.
const verifier = {
  async verifyAccessToken(token: string) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    if (token === 'admin')
      return {token, clientId: 'cli', scopes: ['admin'], expiresAt};
    if (token === 'user')
      return {token, clientId: 'cli', scopes: [], expiresAt};
    // An OAuth error maps to a 401 (a plain Error would be a 500).
    throw new InvalidTokenError('invalid token');
  },
};

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: {name: 'x', version: '0'},
  },
});

describe('mcp-http (Streamable HTTP transport)', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'http-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app);
    await app.start();
    const server = await app.restServer;
    mcpUrl = new URL(server.url + '/mcp');
  });

  afterEach(async () => app.stop());

  async function connect() {
    const client = new Client({name: 'test-client', version: '0.0.0'});
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    await client.connect(transport);
    return {client, transport};
  }

  it('completes the initialize handshake and assigns a session', async () => {
    const {client, transport} = await connect();
    // The client negotiated a session id with the server.
    expect(transport.sessionId).toBeTruthy();
    await client.close();
  });

  it('lists tools over HTTP', async () => {
    const {client} = await connect();
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['add', 'echo']);
    await client.close();
  });

  it('calls a tool and returns structured content', async () => {
    const {client} = await connect();
    const result = await client.callTool({
      name: 'add',
      arguments: {a: 2, b: 40},
    });
    expect(result.structuredContent).toEqual({sum: 42});
    await client.close();
  });

  it('surfaces a tool input validation error', async () => {
    const {client} = await connect();
    const result = await client.callTool({name: 'echo', arguments: {text: ''}});
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('reads a resource and gets a prompt over HTTP', async () => {
    const {client} = await connect();
    const res = await client.readResource({uri: 'demo://motd'});
    expect(res.contents[0]).toMatchObject({
      uri: 'demo://motd',
      text: 'hello over http',
    });
    const pr = await client.getPrompt({name: 'welcome'});
    expect(pr.messages[0].content).toMatchObject({
      type: 'text',
      text: 'Welcome!',
    });
    await client.close();
  });

  it('isolates concurrent sessions', async () => {
    const a = await connect();
    const b = await connect();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    const [ra, rb] = await Promise.all([
      a.client.callTool({name: 'add', arguments: {a: 1, b: 1}}),
      b.client.callTool({name: 'add', arguments: {a: 10, b: 10}}),
    ]);
    expect(ra.structuredContent).toEqual({sum: 2});
    expect(rb.structuredContent).toEqual({sum: 20});
    await a.client.close();
    await b.client.close();
  });

  it('rejects a POST with an unknown session id', async () => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    expect(r.status).toBe(404);
  });

  it('rejects a disallowed Origin when DNS-rebinding protection is on', async () => {
    const guarded = new RestApplication({});
    guarded.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    guarded.component(MCPComponent);
    guarded.configure('servers.MCPServer').to({
      name: 'guarded',
      version: '0.0.0',
      transports: {stdio: false},
    });
    guarded.service(DemoTools);
    await guarded.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(guarded, {allowedOrigins: ['http://allowed.example']});
    await guarded.start();
    const url = new URL((await guarded.restServer).url + '/mcp');
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          origin: 'http://evil.example',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {name: 'x', version: '0'},
          },
        }),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await guarded.stop();
    }
  });
});

describe('mcp-http (app-level middleware chain fronts /mcp)', () => {
  // Regression: the RestServer mounts the LB-style middleware chain as its
  // FIRST handler (in the constructor), so a middleware bound via
  // `app.middleware(...)` before `app.start()` must run for `/mcp` requests —
  // even though `installMcpHttp` mounts the `/mcp` routes before `start()`.
  // Previously the chain was mounted in `start()`, behind those routes, so the
  // MCP handler owned the response and the chain never ran for `/mcp`.
  it('runs a bound app.middleware() for a POST /mcp request', async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'mw-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);

    const seenPaths: string[] = [];
    app.middleware(async (ctx, next) => {
      seenPaths.push(ctx.request.path);
      // Prove the chain runs BEFORE the MCP handler flushes by stamping a
      // header that survives onto the HTTP response.
      ctx.response.setHeader('x-mw-ran', 'yes');
      return next();
    });

    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app);
    await app.start();
    try {
      const url = new URL((await app.restServer).url + '/mcp');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: initBody,
      });
      // The initialize handshake succeeds AND the chain observed the request.
      expect(res.status).toBeLessThan(400);
      expect(res.headers.get('x-mw-ran')).toBe('yes');
      expect(seenPaths).toContain('/mcp');
    } finally {
      await app.stop();
    }
  });
});

describe('mcp-http (OAuth resource-server + scope ACL)', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'secure',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(SecureTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {
      auth: {
        verifier,
        resource: 'https://example.test/mcp',
        authorizationServers: ['https://as.example.test'],
        scopesSupported: ['admin'],
      },
    });
    await app.start();
    mcpUrl = new URL((await app.restServer).url + '/mcp');
  });

  afterEach(async () => app.stop());

  async function connect(token: string) {
    const client = new Client({name: 'test-client', version: '0.0.0'});
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {headers: {Authorization: `Bearer ${token}`}},
    });
    await client.connect(transport);
    return {client, transport};
  }

  it('challenges unauthenticated requests with 401 + WWW-Authenticate', async () => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: initBody,
    });
    expect(r.status).toBe(401);
    const challenge = r.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/Bearer/);
    expect(challenge).toMatch(/resource_metadata/);
  });

  it('serves RFC 9728 protected-resource metadata', async () => {
    const r = await fetch(
      new URL('/.well-known/oauth-protected-resource', mcpUrl),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(body.resource).toBe('https://example.test/mcp');
    expect(body.authorization_servers).toContain('https://as.example.test');
  });

  it('hides scoped tools from a caller without the scope', async () => {
    const {client} = await connect('user');
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('echo');
    expect(names).not.toContain('secret');
    await client.close();
  });

  it('exposes and runs scoped tools for a caller with the scope', async () => {
    const {client} = await connect('admin');
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('secret');
    const result = await client.callTool({name: 'secret', arguments: {}});
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('injects the per-request auth identity into a tool handler', async () => {
    const {client} = await connect('admin');
    const result = await client.callTool({name: 'whoami', arguments: {}});
    const text = (result.content as Array<{text: string}>)[0].text;
    expect(text).toContain('admin'); // scope from the caller's token
    expect(text).toContain('cli'); // clientId from the caller's token
    await client.close();
  });

  it('rejects an invalid bearer token', async () => {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer nope',
      },
      body: initBody,
    });
    expect(r.status).toBe(401);
  });
});

describe('mcp-http (resumable EventStore)', () => {
  it('InMemoryEventStore replays only later events of the same stream', async () => {
    const store = new InMemoryEventStore();
    const msg = (id: number): JSONRPCMessage => ({
      jsonrpc: '2.0',
      id,
      result: {},
    });
    const e1 = await store.storeEvent('s1', msg(1));
    const e2 = await store.storeEvent('s1', msg(2));
    await store.storeEvent('s2', msg(3)); // different stream — must not replay
    const replayed: string[] = [];
    const streamId = await store.replayEventsAfter(e1, {
      send: async eventId => {
        replayed.push(eventId);
      },
    });
    expect(streamId).toBe('s1');
    expect(replayed).toEqual([e2]);
  });

  it('serves tools over HTTP with an eventStore configured', async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'resumable',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {eventStore: new InMemoryEventStore()});
    await app.start();
    try {
      const url = new URL((await app.restServer).url + '/mcp');
      const client = new Client({name: 'test-client', version: '0.0.0'});
      await client.connect(new StreamableHTTPClientTransport(url));
      const {tools} = await client.listTools();
      expect(tools.map(t => t.name).sort()).toEqual(['add', 'echo']);
      await client.close();
    } finally {
      await app.stop();
    }
  });
});
