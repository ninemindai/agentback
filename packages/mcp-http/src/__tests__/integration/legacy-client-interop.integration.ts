// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {OAuthError, OAuthErrorCode} from '@modelcontextprotocol/server';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp} from '../../index.js';

// The 2025-era client, pinned. Every other test in this package drives the
// server with `@modelcontextprotocol/client@2.0.0` — the same rewrite our
// server is built on, so those tests prove the two halves of one release
// agree, not that we are compatible with anything older.
//
// `mcp-client-2025` is an alias for `@modelcontextprotocol/sdk@1.17.0`
// (released 2025-07-24, a year before the 2026-07-28 revision). It predates
// the v2 package split entirely, vendors its own zod 3, and shares nothing
// with our tree but the wire — which is the point. Serving it is the central
// promise of `protocol: 'both'`, and until now nothing checked it.
import {Client as LegacyClient} from 'mcp-client-2025/client/index.js';
import {StreamableHTTPClientTransport as LegacyTransport} from 'mcp-client-2025/client/streamableHttp.js';
import {LATEST_PROTOCOL_VERSION as LEGACY_LATEST} from 'mcp-client-2025/types.js';

const EchoIn = z.object({text: z.string().min(1)});

@mcpServer()
class DemoTools {
  @tool('echo', {description: 'echo back', input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('boom')
  boom() {
    throw new Error('tool exploded');
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

describe('interop with a released 2025-era MCP client', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  async function start(opts: {
    protocol?: 'legacy' | 'both';
    listener?: 'native' | 'node';
    auth?: boolean;
  }) {
    const listener = opts.listener ?? 'native';
    app = new RestApplication({rest: {listener}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener,
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'interop',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {
      ...(opts.protocol ? {protocol: opts.protocol} : {}),
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

  /** Connect the OLD client. It has no era negotiation — 2025 is all it has. */
  async function connectLegacy(token?: string) {
    const client = new LegacyClient({name: 'legacy-client', version: '1.17.0'});
    const transport = new LegacyTransport(mcpUrl, {
      ...(token
        ? {requestInit: {headers: {authorization: `Bearer ${token}`}}}
        : {}),
    });
    await client.connect(transport);
    return {client, transport};
  }

  afterEach(async () => app?.stop());

  // Guard on the fixture itself. If someone bumps the alias to a client that
  // speaks 2026, every assertion below keeps passing while testing nothing —
  // the failure mode a pinned-version interop test exists to avoid. Fail here,
  // loudly, instead.
  it('is pinned to a client that cannot speak the 2026 revision', () => {
    expect(LEGACY_LATEST).toBe('2025-06-18');
  });

  it("talks to protocol: 'both' over a real socket", async () => {
    // The central compatibility promise: one endpoint, and a client written a
    // year before the revision existed still works.
    await start({protocol: 'both'});
    const {client} = await connectLegacy();

    expect(client.getServerVersion()?.name).toBe('interop');
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['boom', 'echo', 'secret']);
    // Not just a handshake — the schema survives the trip and the tool runs.
    expect(tools.find(t => t.name === 'echo')?.inputSchema).toMatchObject({
      type: 'object',
      properties: {text: {type: 'string'}},
    });
    const res = await client.callTool({
      name: 'echo',
      arguments: {text: 'from-2025'},
    });
    expect(JSON.stringify(res.content)).toContain('from-2025');
    await client.close();
  });

  it("negotiates the 2025 revision, not ours, under protocol: 'both'", async () => {
    await start({protocol: 'both'});
    const {client} = await connectLegacy();
    // The old client would reject a version it does not know, so a successful
    // connect already implies this — assert it anyway so a regression names
    // the cause instead of surfacing as an opaque connect failure.
    expect(client.getServerCapabilities()).toBeDefined();
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': LEGACY_LATEST,
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    await client.close();
  });

  it("gets no session id under protocol: 'both' and does not need one", async () => {
    // The v1 transport tracks a session id from the initialize response and
    // echoes it on later requests. Statelessly there is none, so this pins
    // that the old client tolerates its absence rather than wedging.
    await start({protocol: 'both'});
    const {client, transport} = await connectLegacy();
    expect(transport.sessionId).toBeUndefined();
    expect((await client.listTools()).tools.length).toBe(3);
    expect((await client.listTools()).tools.length).toBe(3); // still fine twice
    await client.close();
  });

  it('still gets a real session under the default (legacy) protocol', async () => {
    // The session machinery S7 proposes deleting. This is the evidence for
    // the compatibility matrix: a real released client does use it.
    await start({protocol: 'legacy', listener: 'node'});
    const {client, transport} = await connectLegacy();
    expect(transport.sessionId).toBeTypeOf('string');
    const first = transport.sessionId;
    expect((await client.listTools()).tools.length).toBe(3);
    // The id is stable across calls — one session, reused.
    expect(transport.sessionId).toBe(first);
    await client.close();
  });

  it('surfaces a tool error as an error result, not a transport failure', async () => {
    await start({protocol: 'both'});
    const {client} = await connectLegacy();
    const res = await client.callTool({name: 'boom', arguments: {}});
    expect(res.isError).toBe(true);
    // A bare Error is redacted on both surfaces; the old client must still
    // receive the envelope rather than a dropped connection.
    expect(JSON.stringify(res.content)).not.toContain('tool exploded');
    await client.close();
  });

  it('rejects an invalid argument with a JSON-RPC error the old client parses', async () => {
    await start({protocol: 'both'});
    const {client} = await connectLegacy();
    const res = await client.callTool({name: 'echo', arguments: {text: ''}});
    expect(res.isError).toBe(true);
    await client.close();
  });

  it('carries a bearer token and gates tools by scope', async () => {
    await start({protocol: 'both', auth: true});
    const admin = await connectLegacy('admin');
    expect((await admin.client.listTools()).tools.map(t => t.name)).toContain(
      'secret',
    );
    await admin.client.close();

    const plain = await connectLegacy('plain');
    expect(
      (await plain.client.listTools()).tools.map(t => t.name),
    ).not.toContain('secret');
    await plain.client.close();
  });

  it('is rejected with 401 when its token is invalid', async () => {
    await start({protocol: 'both', auth: true});
    await expect(connectLegacy('nope')).rejects.toThrow();
  });
});
