// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {AuthenticationBindings} from '@agentback/authentication';
import {installMcpHttp} from '../../index.js';

// Two bugs found by reviewing the 0.9.0 default flip, both reachable ONLY on
// the stateless path — which is now the default, so both shipped silently
// enabled. Each test fails against the pre-fix code.
//
// The shared cause is that stateless builds a new server per REQUEST, so
// anything the session path got for free by living once per session had to be
// re-derived here, and two places derived it wrong.

const DeployIn = z.object({env: z.enum(['prod', 'staging'])});

@mcpServer()
class DangerTools {
  @tool('deploy', {input: DeployIn, confirm: true})
  deploy(input: z.infer<typeof DeployIn>) {
    return {deployed: input.env};
  }
}

@mcpServer()
class ScopedTools {
  @tool('public_ping')
  publicPing() {
    return {ok: true};
  }

  @tool('admin_nuke', {scope: 'admin'})
  adminNuke() {
    return {nuked: true};
  }
}

/** A strategy that authenticates nobody — the anonymous branch of optional auth. */
class AnonymousStrategy {
  name = 'api-key';
  async authenticate() {
    return undefined;
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

async function boot(opts: {
  tools: 'danger' | 'scoped';
  protocol?: 'legacy' | 'both';
  perSession?: boolean;
  optionalAuth?: boolean;
}) {
  const app = new RestApplication({rest: {listener: 'native'}});
  app.configure('servers.RestServer').to({
    port: 0,
    host: '127.0.0.1',
    listener: 'native',
  });
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'regress',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(
    (opts.tools === 'danger' ? DangerTools : ScopedTools) as typeof DangerTools,
  );
  if (opts.optionalAuth) {
    app
      .bind('strategies.apiKey')
      .toClass(AnonymousStrategy)
      .tag(AuthenticationBindings.AUTH_STRATEGY);
  }
  await app.get<MCPServer>('servers.MCPServer');
  await installMcpHttp(app, {
    ...(opts.protocol ? {protocol: opts.protocol} : {}),
    ...(opts.perSession ? {perSession: () => {}} : {}),
    ...(opts.optionalAuth
      ? {strategyAuth: {strategy: 'api-key', required: false}}
      : {}),
  });
  await app.start();
  const url = (await app.get<RestServer>('servers.RestServer')).url + '/mcp';

  // The session path needs a real handshake before it accepts anything; the
  // stateless path needs none. Doing it here keeps the tests identical across
  // both protocols, which is the point — the two must agree.
  const headers: Record<string, string> = {...JSON_HEADERS};
  if (opts.protocol === 'legacy') {
    const init = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {name: 'c', version: '0'},
        },
      }),
    });
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
    await init.body?.cancel();
    const ready = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    await ready.body?.cancel();
  }

  const rpc = async (body: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return res.text();
  };
  return {app, rpc};
}

/**
 * Pull the framework error envelope out of a tool result.
 *
 * Responses arrive as an SSE frame whose `data:` line is the JSON-RPC message;
 * the tool's error envelope is JSON nested one level deeper inside
 * `result.content[0].text`. Parse both levels rather than regexing the raw
 * text — an earlier version of this helper matched on escaped quotes and
 * silently returned `{}` for well-formed responses.
 */
function toolError(raw: string): {code?: string; confirmationToken?: string} {
  const line = raw
    .split('\n')
    .find(l => l.startsWith('data:'))
    ?.slice(5)
    .trim();
  if (!line) return {};
  const msg = JSON.parse(line) as {
    result?: {content?: {text?: string}[]};
  };
  const text = msg.result?.content?.[0]?.text;
  if (!text) return {};
  return (JSON.parse(text) as {error?: Record<string, string>}).error ?? {};
}

describe('regression: confirm: survives a per-request server', () => {
  let app: RestApplication;
  afterEach(async () => app?.stop());

  it('round-trips a confirmation token with perSession + stateless', async () => {
    // The store used to be an instance-level fallback on MCPServer. Stateless
    // + perSession builds a fresh MCPServer per request, so the token was
    // written into a store that was thrown away and the retry was answered
    // `confirmation_invalid` — the tool could never be run at all. The store is
    // now bound app-level by MCPComponent, so every per-request child resolves
    // the same one by walking the chain.
    const t = await boot({tools: 'danger', perSession: true});
    app = t.app;

    const first = await t.rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {name: 'deploy', arguments: {env: 'prod'}},
    });
    const err = toolError(first);
    expect(err.code).toBe('confirmation_required');
    expect(err.confirmationToken).toBeTruthy();

    const second = await t.rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'deploy',
        arguments: {env: 'prod', confirmationToken: err.confirmationToken},
      },
    });
    expect(second).toContain('deployed');
    expect(second).not.toContain('confirmation_invalid');
  });
});

describe('regression: scope filtering under optional auth', () => {
  let app: RestApplication;
  afterEach(async () => app?.stop());

  // `@tool({scope})` is a VISIBILITY gate — nothing re-checks it at call time.
  // So a server that fails to filter does not merely leak the tool's existence,
  // it executes it. The stateless factory wrote `authInfo ? {scopes} : {}`,
  // which looks equivalent to the session path's
  // `authEnabled ? (scopes ?? []) : undefined` and is not: an anonymous caller
  // under OPTIONAL auth got `undefined`, and buildServer skips filtering
  // entirely when scopes is undefined.
  for (const protocol of ['legacy', 'both'] as const) {
    it(`hides AND refuses a scoped tool from an anonymous caller (${protocol})`, async () => {
      const t = await boot({
        tools: 'scoped',
        protocol,
        optionalAuth: true,
      });
      app = t.app;

      const list = await t.rpc({jsonrpc: '2.0', id: 1, method: 'tools/list'});
      expect(list).toContain('public_ping');
      expect(list).not.toContain('admin_nuke');

      const called = await t.rpc({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {name: 'admin_nuke', arguments: {}},
      });
      // The payload the tool would have returned must not appear.
      expect(called).not.toContain('nuked');
    });
  }

  it('still shows a scoped tool to a caller that holds the scope', async () => {
    // The fix must deny the anonymous case without breaking the authorized one.
    const app2 = new RestApplication({rest: {listener: 'native'}});
    app2.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app2.component(MCPComponent);
    app2.configure('servers.MCPServer').to({
      name: 'regress',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app2.service(ScopedTools);
    await app2.get<MCPServer>('servers.MCPServer');
    // No auth configured at all => no scope filtering, the documented posture.
    await installMcpHttp(app2, {protocol: 'both'});
    await app2.start();
    app = app2;
    const url = (await app2.get<RestServer>('servers.RestServer')).url + '/mcp';
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    expect(await res.text()).toContain('admin_nuke');
  });
});
