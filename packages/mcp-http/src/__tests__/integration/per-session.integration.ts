// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {OAuthError, OAuthErrorCode} from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

// Per-session MCP servers over Streamable HTTP.
//
// A `@mcpServer()` tool class bound into a *session* context (via the
// `perSession` binder) is discovered ONLY for that session, while app-level
// tools stay shared. The binder keys off the AUTHENTICATED principal
// (`req.auth.clientId`, set by the OAuth resource-server guard) — never a raw
// header — it is bound at MCPBindings.REQUEST_AUTH before the binder runs, so
// the binder never digs through a host-specific request object. Covers:
// discovery isolation, dispatch, composition with scope filtering,
// session→principal pinning, per-session context disposal, and that ONE binder
// behaves identically on the Express and fetch/edge hosts.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {Context} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {
  MCPBindings,
  MCPComponent,
  MCPServer,
  addTool,
  mcpServer,
  tool,
} from '@agentback/mcp';
import type {AuthInfo} from '@agentback/mcp-http';
import {installMcpHttp} from '../../index.js';

const EchoIn = z.object({text: z.string().min(1)});
const EchoOut = z.object({echoed: z.string()});
const NoIn = z.object({});
const SecretOut = z.object({secret: z.string()});

// Shared, app-level tool — every session sees it.
@mcpServer()
class SharedTools {
  @tool('echo', {description: 'echo back', input: EchoIn, output: EchoOut})
  echo(input: z.infer<typeof EchoIn>): z.infer<typeof EchoOut> {
    return {echoed: input.text};
  }
}

// Alice-only tools — bound into Alice's session context, never on the app.
// `alice-admin` is additionally scope-gated to prove discovery + filtering
// compose.
@mcpServer()
class AliceTools {
  @tool('alice-secret', {
    description: "alice's private tool",
    input: NoIn,
    output: SecretOut,
  })
  aliceSecret(_input: z.infer<typeof NoIn>): z.infer<typeof SecretOut> {
    return {secret: 'for alice only'};
  }

  @tool('alice-admin', {description: 'needs admin scope', scope: 'admin'})
  aliceAdmin() {
    return {ok: true};
  }
}

// Demo verifier: bearer token -> AuthInfo. A real one validates a JWT against
// the AS's JWKS. `clientId` is the stable principal the binder keys off.
const verifier = {
  async verifyAccessToken(token: string) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    switch (token) {
      case 'alice-admin':
        return {token, clientId: 'alice', scopes: ['admin'], expiresAt};
      case 'alice-basic':
        return {token, clientId: 'alice', scopes: [], expiresAt};
      case 'bob':
        return {token, clientId: 'bob', scopes: [], expiresAt};
      default:
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
    }
  },
};

// Capture the most recently created session context so tests can assert it is
// disposed. The binder's first arg IS the session context.
let lastSessionCtx: Context | undefined;

describe('mcp-http (per-session tool discovery)', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  beforeEach(async () => {
    lastSessionCtx = undefined;
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'per-session-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    // Only the SHARED tools are registered on the app.
    app.service(SharedTools);
    await app.get<MCPServer>('servers.MCPServer');

    await installMcpHttp(app, {
      protocol: 'legacy',
      auth: {
        verifier,
        resource: 'https://example.test/mcp',
        authorizationServers: ['https://as.example.test'],
      },
      // Key off the VALIDATED principal, never a header. It is bound at
      // REQUEST_AUTH before the binder runs — host-neutral, and the only
      // spoof-proof source (the request object is not one).
      async perSession(ctx) {
        lastSessionCtx = ctx;
        const principal = await ctx.get(MCPBindings.REQUEST_AUTH, {
          optional: true,
        });
        if (principal?.clientId === 'alice') addTool(ctx, AliceTools);
      },
    });
    await app.start();
    mcpUrl = new URL((await app.restServer).url + '/mcp');
  });

  afterEach(async () => app.stop());

  async function connectAs(token: string) {
    const client = new Client({name: 'test-client', version: '0.0.0'});
    const transport = new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {headers: {Authorization: `Bearer ${token}`}},
    });
    await client.connect(transport);
    return {client, transport};
  }

  const toolNames = async (client: Client) =>
    (await client.listTools()).tools.map(t => t.name).sort();

  it("surfaces Alice's session-bound tools only to Alice", async () => {
    const alice = await connectAs('alice-admin');
    const bob = await connectAs('bob');
    // Alice: shared + her own (admin scope present, so alice-admin shows too).
    expect(await toolNames(alice.client)).toEqual([
      'alice-admin',
      'alice-secret',
      'echo',
    ]);
    // Bob: shared only — Alice's tools don't exist for him.
    expect(await toolNames(bob.client)).toEqual(['echo']);
    await alice.client.close();
    await bob.client.close();
  });

  it('composes discovery with scope filtering', async () => {
    // Same principal (alice) but no admin scope: still gets AliceTools bound
    // (discovery), but the scope-gated alice-admin is filtered out.
    const basic = await connectAs('alice-basic');
    expect(await toolNames(basic.client)).toEqual(['alice-secret', 'echo']);
    await basic.client.close();
  });

  it("dispatches Alice's session-bound tool through its own binding", async () => {
    const alice = await connectAs('alice-admin');
    const result = await alice.client.callTool({
      name: 'alice-secret',
      arguments: {},
    });
    expect(result.structuredContent).toEqual({secret: 'for alice only'});
    await alice.client.close();
  });

  it("rejects Alice's tool for a different user (not discovered)", async () => {
    const bob = await connectAs('bob');
    const result = await bob.client.callTool({
      name: 'alice-secret',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    await bob.client.close();
  });

  it('keeps the shared app-level tool working for every session', async () => {
    const alice = await connectAs('alice-admin');
    const bob = await connectAs('bob');
    const [ra, rb] = await Promise.all([
      alice.client.callTool({name: 'echo', arguments: {text: 'hi-alice'}}),
      bob.client.callTool({name: 'echo', arguments: {text: 'hi-bob'}}),
    ]);
    expect(ra.structuredContent).toEqual({echoed: 'hi-alice'});
    expect(rb.structuredContent).toEqual({echoed: 'hi-bob'});
    await alice.client.close();
    await bob.client.close();
  });

  it('pins a session to its owning principal (403 for a different token)', async () => {
    const alice = await connectAs('alice-admin');
    const sessionId = alice.transport.sessionId!;
    // A DIFFERENT valid principal (bob) replays Alice's session id.
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
        authorization: 'Bearer bob',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    expect(res.status).toBe(403);
    await alice.client.close();
  });

  it('disposes the session context on session DELETE', async () => {
    const alice = await connectAs('alice-admin');
    const ctx = lastSessionCtx!;
    expect(ctx).toBeInstanceOf(Context);
    const closeSpy = vi.spyOn(ctx, 'close');
    // Explicit DELETE so we can await the server processing it (the SDK
    // client's close() resolves client-side before the server's onclose runs).
    const res = await fetch(mcpUrl, {
      method: 'DELETE',
      headers: {
        'mcp-session-id': alice.transport.sessionId!,
        authorization: 'Bearer alice-admin',
      },
    });
    expect(res.status).toBeLessThan(300); // session terminated
    expect(closeSpy).toHaveBeenCalled(); // transport close -> ctx.close
  });

  it('closes outstanding session contexts on app.stop()', async () => {
    await connectAs('alice-admin'); // intentionally NOT closed by the client
    const ctx = lastSessionCtx!;
    const closeSpy = vi.spyOn(ctx, 'close');
    await app.stop(); // stop hook -> closeAll -> transport close -> ctx.close
    expect(closeSpy).toHaveBeenCalled();
    // afterEach calls app.stop() again — idempotent.
  });
});

// The binder used to receive a different, incompatible `req` on each host: the
// Express mount passed an Express request while the fetch mount passed a Web
// Request behind a cast, and the shared `SessionBinder` type claimed the Express
// shape. A binder written to the documented signature (`req.auth`) therefore
// broke on the edge host — and no test caught it, because `perSession` had no
// fetch-host coverage at all. Both hosts now share one seam; this pins it.
describe('perSession host parity', () => {
  const verifier = {
    async verifyAccessToken(token: string) {
      if (token === 'alice' || token === 'bob')
        return {
          token,
          clientId: token,
          scopes: [],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        };
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'bad token');
    },
  };

  for (const listener of ['express', 'native'] as const) {
    describe(`${listener} host`, () => {
      let app: RestApplication;
      let mcpUrl: URL;
      const seen: Array<{isWebRequest: boolean; clientId?: string}> = [];

      beforeEach(async () => {
        seen.length = 0;
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
          name: 'parity',
          version: '0.0.0',
          transports: {stdio: false},
        });
        app.service(SharedTools);
        await app.get<MCPServer>('servers.MCPServer');
        await installMcpHttp(app, {
          protocol: 'legacy',
          auth: {
            verifier,
            resource: 'https://example.test/mcp',
            authorizationServers: ['https://as.example.test'],
          },
          async perSession(ctx, request) {
            const principal = await ctx.get(MCPBindings.REQUEST_AUTH, {
              optional: true,
            });
            seen.push({
              // The one assertion that would have caught the original bug.
              isWebRequest: typeof request?.headers?.get === 'function',
              ...(principal ? {clientId: principal.clientId} : {}),
            });
            if (principal?.clientId === 'alice') addTool(ctx, AliceTools);
          },
        });
        await app.start();
        mcpUrl = new URL((await app.restServer).url + '/mcp');
      });

      afterEach(async () => app.stop());

      async function connectAs(token: string) {
        const client = new Client({name: 'c', version: '0.0.0'});
        const transport = new StreamableHTTPClientTransport(mcpUrl, {
          requestInit: {headers: {authorization: `Bearer ${token}`}},
        });
        await client.connect(transport);
        return client;
      }

      it('hands the binder a Web Request and the validated principal', async () => {
        const client = await connectAs('alice');
        await client.listTools();
        await client.close();

        expect(seen).toHaveLength(1);
        expect(seen[0].isWebRequest).toBe(true);
        expect(seen[0].clientId).toBe('alice');
      });

      it('isolates session-local tools by principal', async () => {
        const alice = await connectAs('alice');
        const aliceTools = (await alice.listTools()).tools.map(t => t.name);
        await alice.close();

        const bob = await connectAs('bob');
        const bobTools = (await bob.listTools()).tools.map(t => t.name);
        await bob.close();

        expect(aliceTools).toContain('alice-secret');
        expect(bobTools).not.toContain('alice-secret');
        expect(bobTools).toContain('echo'); // shared app-level tool
      });
    });
  }
});
