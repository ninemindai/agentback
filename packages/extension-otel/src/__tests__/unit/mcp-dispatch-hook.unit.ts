// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {Context} from '@agentback/context';
import {Application} from '@agentback/core';
import {
  MCP_DISPATCH_HOOK_TAG,
  MCPBindings,
  MCPServer,
  type ToolBinding,
} from '@agentback/mcp';
import {mcpServer, tool} from '@agentback/mcp';
import {
  InMemoryUsageSink,
  Meter,
  MeteringComponent,
  MeteringBindings,
} from '@agentback/metering';
import {createOtelMcpDispatchHook} from '../../index.js';
import {setupTestTracing} from '../support/test-tracing.js';

const tracing = setupTestTracing();

const EchoIn = z.object({text: z.string().min(1)});

@mcpServer()
class EchoTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('explode')
  explode(): void {
    throw new Error('nope');
  }
}

/** Access the protected dispatchTool seam for the auth-attribution test. */
type DispatchableServer = MCPServer & {
  dispatchTool(t: ToolBinding, input: unknown, ctx?: Context): Promise<unknown>;
};

function givenApp(serverClass: typeof MCPServer = MCPServer) {
  const app = new Application();
  app.server(serverClass, 'MCPServer');
  app.configure('servers.MCPServer').to({
    name: 'otel-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app
    .bind('otel.dispatchHook.mcp')
    .to(createOtelMcpDispatchHook())
    .tag(MCP_DISPATCH_HOOK_TAG);
  app.service(EchoTools);
  return app;
}

describe('MCP dispatch hook', () => {
  let app: Application;
  let server: MCPServer;

  beforeEach(async () => {
    tracing.exporter.reset();
    app = givenApp();
    server = await app.get<MCPServer>('servers.MCPServer');
  });

  afterAll(() => {
    tracing.reset();
  });

  it('wraps a tool call in an INTERNAL span named mcp.tool <name>', async () => {
    const result = await server.callTool('echo', {text: 'hi'});
    expect(result).toEqual({echoed: 'hi'});
    const span = tracing.spans().find(s => s.name === 'mcp.tool echo')!;
    expect(span).toBeDefined();
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.attributes['mcp.tool.name']).toBe('echo');
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('records exceptions and sets ERROR status when the tool throws', async () => {
    await expect(server.callTool('explode', {})).rejects.toThrow('nope');
    const span = tracing.spans().find(s => s.name === 'mcp.tool explode')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    const exception = span.events.find(e => e.name === 'exception');
    expect(exception?.attributes?.['exception.message']).toBe('nope');
  });

  it('records validation failures as the thrown error', async () => {
    await expect(server.callTool('echo', {text: ''})).rejects.toThrow(
      /Invalid input for tool echo/,
    );
    const span = tracing.spans().find(s => s.name === 'mcp.tool echo')!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toMatch(/Invalid input for tool echo/);
  });

  it('attributes enduser.id from REQUEST_AUTH clientId when bound', async () => {
    const echo = server.listTools().find(t => t.meta.name === 'echo')!;
    const reqCtx = new Context(app, 'mcp.request');
    reqCtx.bind(MCPBindings.REQUEST_AUTH).to({
      token: 'opaque-token',
      clientId: 'client-42',
      scopes: [],
    });
    const result = await (server as DispatchableServer).dispatchTool(
      echo,
      {text: 'who'},
      reqCtx,
    );
    expect(result).toEqual({echoed: 'who'});
    const span = tracing.spans().find(s => s.name === 'mcp.tool echo')!;
    expect(span.attributes['enduser.id']).toBe('client-42');
  });

  it('composes with the metering hook: one call produces a span AND a usage event', async () => {
    // Two cross-cutting concerns as sibling dispatch hooks — the
    // composition the subclass-only design could not express. Both
    // observability signals fire per call.
    const meteredApp = givenApp();
    meteredApp.component(MeteringComponent);
    const sink = new InMemoryUsageSink();
    meteredApp.bind(MeteringBindings.METER.key).to(new Meter(sink));
    const metered = await meteredApp.get<MCPServer>('servers.MCPServer');
    const result = await metered.callTool('echo', {text: 'both'});
    expect(result).toEqual({echoed: 'both'});

    const span = tracing.spans().find(s => s.name === 'mcp.tool echo')!;
    expect(span).toBeDefined();
    expect(span.attributes['mcp.tool.name']).toBe('echo');

    const events = sink.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: 'mcp',
      operation: 'echo',
      status: 'ok',
    });
  });
});
