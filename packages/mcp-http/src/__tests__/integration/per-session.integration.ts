// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
import {OAuthError} from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

// License text available at https://opensource.org/license/mit/

// Per-session MCP servers over Streamable HTTP.
//
// A `@mcpServer()` tool class bound into a *session* context (via the
// `perSession` binder) is discovered ONLY for that session, while app-level
// tools stay shared. The binder keys off the AUTHENTICATED principal
// (`req.auth.clientId`, set by the OAuth resource-server guard) — never a raw
// header. Covers: discovery isolation, dispatch, composition with scope
// filtering, session→principal pinning, and per-session context disposal.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {Context} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {
  addTool,
  MCPComponent,
  MCPServer,
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
        throw new OAuthError('invalid_token', 'invalid token');
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
      auth: {
        verifier,
        resource: 'https://example.test/mcp',
        authorizationServers: ['https://as.example.test'],
      },
      // Key off the VALIDATED principal, never a header.
      perSession(ctx, req) {
        lastSessionCtx = ctx;
        const principal = req.auth as AuthInfo | undefined;
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
