// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Context} from '@agentback/core';
import {
  MCPBindings,
  MCPComponent,
  MCPServer,
  mcpServer,
  tool,
} from '@agentback/mcp';
import {Application} from '@agentback/core';
import {resolveSessionServer, toHostnames} from '../../session.js';

@mcpServer()
class Tools {
  @tool('ping')
  ping() {
    return {ok: true};
  }
}

async function givenApp() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'sess',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(Tools);
  await app.get<MCPServer>('servers.MCPServer');
  return app;
}

const req = () => new Request('http://test.local/mcp', {method: 'POST'});

describe('resolveSessionServer', () => {
  it('closes the half-built context when the binder throws', async () => {
    // Under stateless serving this path runs on EVERY failed request, not once
    // per failed session — so a missed close here is a per-request leak during
    // exactly the outage that triggers it.
    const app = await givenApp();
    let closed = false;
    const boom = new Error('entitlement service down');

    await expect(
      resolveSessionServer({
        appContext: app,
        request: req(),
        binder: ctx => {
          const original = ctx.close.bind(ctx);
          ctx.close = () => {
            closed = true;
            original();
          };
          throw boom;
        },
      }),
    ).rejects.toBe(boom); // the original error, not a wrapped one

    expect(closed).toBe(true);
    await app.stop();
  });

  it('binds the principal before the binder runs', async () => {
    // Ordering matters: a binder that reads REQUEST_AUTH to decide tool
    // visibility must not see an empty context.
    const app = await givenApp();
    let seen: string | undefined;
    const {sessionCtx} = await resolveSessionServer({
      appContext: app,
      request: req(),
      authInfo: {token: 't', clientId: 'c', scopes: [], extra: {sub: 'alice'}},
      binder: async ctx => {
        const auth = await ctx.get(MCPBindings.REQUEST_AUTH, {optional: true});
        seen = auth?.extra?.sub as string | undefined;
      },
    });
    expect(seen).toBe('alice');
    sessionCtx.close();
    await app.stop();
  });
});

describe('toHostnames', () => {
  it('normalizes every documented allowlist form to a hostname', () => {
    // The SDK validators compare hostnames; our option is documented as Origin
    // HEADER VALUES. Getting this wrong rejects all traffic, fail-closed but
    // broken, so each accepted form is pinned.
    expect(
      toHostnames([
        'https://app.example.com',
        'http://localhost:3000',
        'mcp.example.com',
        'mcp.example.com:8080',
        '127.0.0.1:9000',
      ]),
    ).toEqual([
      'app.example.com',
      'localhost',
      'mcp.example.com',
      'mcp.example.com',
      '127.0.0.1',
    ]);
  });

  it('passes an unparseable entry through rather than dropping it', () => {
    // An allowlist entry that never matches is safer than one silently removed.
    expect(toHostnames(['not a url'])).toEqual(['not a url']);
  });
});
