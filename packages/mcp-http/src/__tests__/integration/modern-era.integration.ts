// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createMcpHandler} from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  McpRequestContext,
  McpHttpHandler,
} from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';

// Proves the 2026-07-28 ("modern") protocol era works against AgentBack's own
// MCPServer, in-process and without a socket. This is the harness the stateless
// migration needs (docs/proposals/mcp-2026-stateless.md §8): the SDK's
// InMemoryTransport speaks the 2025 era ONLY, so modern-era coverage has to
// drive createMcpHandler's fetch face through a client transport with an
// injected `fetch`.
//
//   Client (versionNegotiation) --fetch--> handler.fetch(Request, {authInfo})
//                                             └─ factory({era, authInfo, req})
//                                                  └─ MCPServer.buildServer()
//
// It doubles as the spike for §2-3 of that proposal, which were written from the
// SDK's emitted types rather than from a running server. What it establishes:
//   - the factory is invoked once per REQUEST (not per connection)
//   - `authInfo` reaches the factory as strict pass-through (we verify tokens,
//     the SDK never does), so per-request tool discovery is possible
//   - the same factory serves BOTH eras from one entry point

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

async function givenMcpServer() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'modern-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(DemoTools);
  return {app, mcp: await app.get<MCPServer>('servers.MCPServer')};
}

/** Records every factory invocation so per-request construction is observable. */
function trackingFactory(mcp: MCPServer) {
  const calls: McpRequestContext[] = [];
  const factory = (ctx: McpRequestContext) => {
    calls.push(ctx);
    // Scope-gate exactly as the transport mounts do today: the principal's
    // scopes decide which tools are even registered.
    const scopes = ctx.authInfo ? (ctx.authInfo.scopes ?? []) : undefined;
    return mcp.buildServer(scopes ? {scopes} : {});
  };
  return {calls, factory};
}

/** Drive a handler in-process — the URL is never dialed. */
function connectTo(
  handler: McpHttpHandler,
  opts: {authInfo?: AuthInfo; mode?: 'auto' | 'legacy'} = {},
) {
  const client = new Client(
    {name: 'test-client', version: '0.0.0'},
    opts.mode === 'legacy' ? {} : {versionNegotiation: {mode: 'auto' as const}},
  );
  const transport = new StreamableHTTPClientTransport(
    new URL('http://test.local/mcp'),
    {
      fetch: (url: string | URL | Request, init?: RequestInit) =>
        handler.fetch(new Request(url as string | URL, init), {
          ...(opts.authInfo ? {authInfo: opts.authInfo} : {}),
        }),
    },
  );
  return {client, transport};
}

const principal = (scopes: string[]): AuthInfo => ({
  token: 't',
  clientId: 'cli',
  scopes,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
});

describe('modern era (2026-07-28) over createMcpHandler', () => {
  let handler: McpHttpHandler | undefined;
  let app: Application | undefined;

  afterEach(async () => {
    await handler?.close();
    await app?.stop();
    handler = undefined;
    app = undefined;
  });

  it('negotiates the modern era and serves tools/list + tools/call', async () => {
    const given = await givenMcpServer();
    app = given.app;
    const {factory} = trackingFactory(given.mcp);
    handler = createMcpHandler(factory);

    const {client, transport} = connectTo(handler);
    await client.connect(transport);

    expect(client.getProtocolEra()).toBe('modern');

    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['echo', 'secret']);

    const res = await client.callTool({
      name: 'echo',
      arguments: {text: 'modern'},
    });
    expect(JSON.stringify(res.content)).toContain('modern');
    await client.close();
  });

  it('invokes the factory per REQUEST, not per connection', async () => {
    // The load-bearing claim of the stateless design: there is no session, so
    // each request constructs its own server. If this ever came back as 1, the
    // per-request tool-discovery plan would be built on sand.
    const given = await givenMcpServer();
    app = given.app;
    const {calls, factory} = trackingFactory(given.mcp);
    handler = createMcpHandler(factory);

    const {client, transport} = connectTo(handler);
    await client.connect(transport);
    await client.listTools();
    await client.listTools();
    await client.callTool({name: 'echo', arguments: {text: 'x'}});
    await client.close();

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every(c => c.era === 'modern')).toBe(true);
  });

  it('passes authInfo through to the factory, enabling per-request discovery', async () => {
    // §3 of the proposal: perSession maps to per-request discovery driven by the
    // validated principal — NOT to requestState. This is that claim, executed.
    const given = await givenMcpServer();
    app = given.app;
    const {calls, factory} = trackingFactory(given.mcp);
    handler = createMcpHandler(factory);

    const admin = connectTo(handler, {authInfo: principal(['admin'])});
    await admin.client.connect(admin.transport);
    const adminTools = (await admin.client.listTools()).tools.map(t => t.name);
    await admin.client.close();

    const plain = connectTo(handler, {authInfo: principal([])});
    await plain.client.connect(plain.transport);
    const plainTools = (await plain.client.listTools()).tools.map(t => t.name);
    await plain.client.close();

    expect(calls.every(c => c.authInfo?.clientId === 'cli')).toBe(true);
    expect(adminTools.sort()).toEqual(['echo', 'secret']);
    expect(plainTools).toEqual(['echo']); // scope-gated tool hidden
  });

  it('serves a 2025-era client from the same factory and endpoint', async () => {
    // legacy: 'stateless' is the default. One factory, one endpoint, both eras —
    // this is what makes a same-endpoint migration possible.
    const given = await givenMcpServer();
    app = given.app;
    const {calls, factory} = trackingFactory(given.mcp);
    handler = createMcpHandler(factory);

    const {client, transport} = connectTo(handler, {mode: 'legacy'});
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe('legacy');
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['echo', 'secret']);
    await client.close();

    expect(calls.some(c => c.era === 'legacy')).toBe(true);
  });
});
