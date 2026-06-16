// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Context} from '@agentback/context';
import {securityId, SecurityBindings} from '@agentback/security';
import {MCPBindings} from '@agentback/mcp';
import type {RestDispatchInfo} from '@agentback/rest';
import type {McpDispatchInfo} from '@agentback/mcp';
import {
  createMeteringMcpHook,
  createMeteringRestHook,
} from '../../dispatch-hooks.js';
import {InMemoryUsageSink} from '../../in-memory-sink.js';
import {MeteringBindings} from '../../keys.js';
import {Meter} from '../../meter.js';

function givenApp(traceIdProvider?: () => string | undefined) {
  const app = new Context('app');
  const sink = new InMemoryUsageSink();
  app
    .bind(MeteringBindings.METER)
    .to(new Meter(sink, {now: () => 1000, genId: () => 'e1', traceIdProvider}));
  return {app, sink};
}

class Orders {}

function restInfo(reqCtx?: Context): RestDispatchInfo {
  return {
    // The hook only reads ctor/methodName/ctx.
    request: new Request('http://localhost/orders'),
    responseHeaders: new Headers(),
    ctor: Orders,
    methodName: 'list',
    schemas: {},
    ctx: reqCtx,
  };
}

describe('createMeteringRestHook', () => {
  it('emits one event per dispatch with the post-auth principal', async () => {
    const {app, sink} = givenApp();
    const hook = createMeteringRestHook(app);
    const reqCtx = new Context(app, 'req');
    const result = await hook(restInfo(reqCtx), async () => {
      // Auth binds the principal INSIDE the wrapped pipeline.
      reqCtx.bind(SecurityBindings.USER).to({[securityId]: 'u-9'});
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(sink.all()).toMatchObject([
      {
        surface: 'rest',
        operation: 'Orders.list',
        principal: {kind: 'user', id: 'u-9'},
        status: 'ok',
      },
    ]);
  });

  it('records the mapped status and rethrows on failure', async () => {
    const {app, sink} = givenApp();
    const hook = createMeteringRestHook(app);
    const boom = Object.assign(new Error('nope'), {statusCode: 403});
    await expect(
      hook(restInfo(new Context(app, 'req')), async () => {
        throw boom;
      }),
    ).rejects.toThrow('nope');
    expect(sink.all()[0]).toMatchObject({
      status: 'denied',
      principal: {kind: 'anonymous'},
    });
  });

  it('is a transparent passthrough when no Meter is bound', async () => {
    const app = new Context('app');
    const hook = createMeteringRestHook(app);
    await expect(hook(restInfo(), async () => 42)).resolves.toBe(42);
  });

  it('stamps the active trace id via the provider', async () => {
    const {app, sink} = givenApp(() => 'trace-123');
    const hook = createMeteringRestHook(app);
    await hook(restInfo(new Context(app, 'req')), async () => 'ok');
    expect(sink.all()[0].traceId).toBe('trace-123');
  });
});

describe('createMeteringMcpHook', () => {
  function mcpInfo(app: Context, clientId?: string): McpDispatchInfo {
    const ctx = new Context(app, 'mcp.request');
    if (clientId) {
      ctx
        .bind(MCPBindings.REQUEST_AUTH)
        .to({token: 't', clientId, scopes: []} as never);
    }
    return {
      tool: {ctor: Orders, meta: {name: 'list_orders', methodName: 'list'}},
      input: {},
      ctx,
    };
  }

  it('emits one event per tool call attributed to the caller', async () => {
    const {app, sink} = givenApp();
    const hook = createMeteringMcpHook(app);
    await hook(mcpInfo(app, 'svc-1'), async () => ({ok: true}));
    expect(sink.all()).toMatchObject([
      {
        surface: 'mcp',
        operation: 'list_orders',
        principal: {kind: 'client', id: 'svc-1'},
        status: 'ok',
      },
    ]);
  });

  it('attributes anonymous when no auth is bound', async () => {
    const {app, sink} = givenApp();
    const hook = createMeteringMcpHook(app);
    await hook(mcpInfo(app), async () => 'x');
    expect(sink.all()[0].principal).toEqual({
      kind: 'anonymous',
      id: '$anonymous',
    });
  });
});
