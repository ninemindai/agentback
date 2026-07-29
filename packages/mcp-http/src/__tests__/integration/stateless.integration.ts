// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {OAuthError, OAuthErrorCode} from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp} from '../../index.js';

// `protocol: 'stateless'` serves the 2026-07-28 revision — and 2025-era traffic
// from the same endpoint — with no session at all. Unlike modern-era
// .integration.ts (which drives the handler in-process), this goes over a real
// socket through the fetch/edge host, so it covers the actual mount wiring:
// auth pass-through, both eras on one URL, and the absence of session ops.

const EchoIn = z.object({text: z.string().min(1)});

@mcpServer()
class DemoTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('secret', {scope: 'admin'})
  secret() {
    return {ok: true};
  }
}

const verifier = {
  async verifyAccessToken(token: string) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    if (token === 'admin')
      return {token, clientId: 'cli', scopes: ['admin'], expiresAt};
    if (token === 'plain')
      return {token, clientId: 'cli', scopes: [], expiresAt};
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
  },
};

describe("mcp-http protocol: 'stateless' (fetch host)", () => {
  let app: RestApplication;
  let mcpUrl: URL;

  async function start(opts: {auth?: boolean} = {}) {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'stateless',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {
      protocol: 'stateless',
      ...(opts.auth
        ? {
            auth: {
              verifier,
              resource: 'https://example.test/mcp',
              authorizationServers: ['https://as.example.test'],
            },
          }
        : {}),
    });
    await app.start();
    mcpUrl = new URL(
      (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
    );
  }

  async function connect(opts: {token?: string; modern?: boolean} = {}) {
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      opts.modern === false
        ? {}
        : {versionNegotiation: {mode: 'auto' as const}},
    );
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        ...(opts.token
          ? {
              requestInit: {
                headers: {authorization: `Bearer ${opts.token}`},
              },
            }
          : {}),
      }),
    );
    return client;
  }

  afterEach(async () => app?.stop());

  it('serves the modern era over a real socket', async () => {
    await start();
    const client = await connect();
    expect(client.getProtocolEra()).toBe('modern');
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['echo', 'secret']);
    const res = await client.callTool({
      name: 'echo',
      arguments: {text: 'stateless'},
    });
    expect(JSON.stringify(res.content)).toContain('stateless');
    await client.close();
  });

  it('serves a 2025-era client from the same endpoint', async () => {
    await start();
    const client = await connect({modern: false});
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.length).toBe(2);
    await client.close();
  });

  it('mints no session id — there is no session', async () => {
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

  it('gates tool visibility per request from the bearer principal', async () => {
    await start({auth: true});
    const admin = await connect({token: 'admin'});
    expect((await admin.listTools()).tools.map(t => t.name).sort()).toEqual([
      'echo',
      'secret',
    ]);
    await admin.close();

    const plain = await connect({token: 'plain'});
    expect((await plain.listTools()).tools.map(t => t.name)).toEqual(['echo']);
    await plain.close();
  });

  it('still rejects an invalid bearer token with 401', async () => {
    await start({auth: true});
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer nope',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
});

// S4b: per-request DI contexts, on both hosts. Disposal rides the SDK's own
// lifetime signal — it closes the per-request server when the exchange
// completes, AFTER any streamed progress and before the body finishes draining,
// so `onclose` is the correct release point. Closing when `fetch()` resolves
// would be far too early: fetch() returns before the tool does any work.
describe("protocol: 'stateless' per-request DI contexts", () => {
  for (const listener of ['express', 'native'] as const) {
    describe(`${listener} host`, () => {
      let app: RestApplication;
      let mcpUrl: URL;
      const opened: Array<{closed: boolean}> = [];

      beforeEach(async () => {
        opened.length = 0;
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
          name: 'per-request',
          version: '0.0.0',
          transports: {stdio: false},
        });
        app.service(DemoTools);
        await app.get<MCPServer>('servers.MCPServer');
        await installMcpHttp(app, {
          protocol: 'stateless',
          perSession(ctx) {
            // Track disposal without reaching into Context internals: close()
            // is idempotent and observable through the subscription it drops.
            const record = {closed: false};
            opened.push(record);
            const original = ctx.close.bind(ctx);
            ctx.close = () => {
              record.closed = true;
              original();
            };
          },
        });
        await app.start();
        mcpUrl = new URL(
          (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
        );
      });

      afterEach(async () => app?.stop());

      it('builds one context per request and disposes every one', async () => {
        const client = new Client(
          {name: 'c', version: '0.0.0'},
          {versionNegotiation: {mode: 'auto' as const}},
        );
        await client.connect(new StreamableHTTPClientTransport(mcpUrl));
        await client.listTools();
        await client.callTool({name: 'echo', arguments: {text: 'x'}});
        await client.close();

        // One per HTTP request (discovery probe + list + call), all released.
        expect(opened.length).toBeGreaterThanOrEqual(2);
        expect(opened.every(o => o.closed)).toBe(true);
      });

      it('leaks nothing across many sequential requests', async () => {
        const client = new Client(
          {name: 'c', version: '0.0.0'},
          {versionNegotiation: {mode: 'auto' as const}},
        );
        await client.connect(new StreamableHTTPClientTransport(mcpUrl));
        for (let i = 0; i < 5; i++) {
          await client.callTool({name: 'echo', arguments: {text: `n${i}`}});
        }
        await client.close();

        expect(opened.length).toBeGreaterThanOrEqual(5);
        expect(opened.filter(o => !o.closed)).toEqual([]);
      });
    });
  }
});
