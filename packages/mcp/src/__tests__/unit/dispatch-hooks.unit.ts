// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {authorize} from '@agentback/authorization';
import {Context} from '@agentback/context';
import {Application} from '@agentback/core';
import {securityId, SecurityBindings} from '@agentback/security';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';
import {MCP_DISPATCH_HOOK_TAG, type McpDispatchHook} from '../../keys.js';

const EchoIn = z.object({text: z.string().min(1)});

@mcpServer()
class HookTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @authorize({scopes: ['secret:read']})
  @tool('secret')
  secret() {
    return {classified: true};
  }
}

function recordingHook(name: string, records: string[]): McpDispatchHook {
  return async (info, next) => {
    records.push(`${name}:before:${info.tool.meta.name}`);
    try {
      return await next();
    } finally {
      records.push(`${name}:after:${info.tool.meta.name}`);
    }
  };
}

async function givenApp() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'hook-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(HookTools);
  return app;
}

describe('MCP dispatch hooks', () => {
  let records: string[];

  beforeEach(() => {
    records = [];
  });

  it('two hooks compose as an onion in bind order (first bound outermost)', async () => {
    const app = await givenApp();
    app
      .bind('hooks.first')
      .to(recordingHook('first', records))
      .tag(MCP_DISPATCH_HOOK_TAG);
    app
      .bind('hooks.second')
      .to(recordingHook('second', records))
      .tag(MCP_DISPATCH_HOOK_TAG);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await expect(server.callTool('echo', {text: 'hi'})).resolves.toEqual({
      echoed: 'hi',
    });
    expect(records).toEqual([
      'first:before:echo',
      'second:before:echo',
      'second:after:echo',
      'first:after:echo',
    ]);
  });

  it('wraps the WHOLE dispatchTool body — authorization denials surface as thrown errors', async () => {
    const app = await givenApp();
    const seen: unknown[] = [];
    const hook: McpDispatchHook = async (_info, next) => {
      try {
        return await next();
      } catch (err) {
        seen.push(err);
        throw err;
      }
    };
    app.bind('hooks.observer').to(hook).tag(MCP_DISPATCH_HOOK_TAG);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await expect(server.callTool('secret', {})).rejects.toThrow(/Forbidden/);
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toMatch(
      /Forbidden: not authorized for HookTools.secret/,
    );
  });

  it('sees input-validation failures as thrown errors', async () => {
    const app = await givenApp();
    const seen: Error[] = [];
    const hook: McpDispatchHook = async (_info, next) => {
      try {
        return await next();
      } catch (err) {
        seen.push(err as Error);
        throw err;
      }
    };
    app.bind('hooks.observer').to(hook).tag(MCP_DISPATCH_HOOK_TAG);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await expect(server.callTool('echo', {text: ''})).rejects.toThrow(
      /Invalid input for tool echo/,
    );
    expect(seen[0]!.message).toMatch(/Invalid input for tool echo/);
  });

  it('exposes the per-request child context (principals visible after next())', async () => {
    const app = await givenApp();
    let observedCtx: Context | undefined;
    let observedUser: unknown;
    const hook: McpDispatchHook = async (info, next) => {
      observedCtx = info.ctx;
      const result = await next();
      observedUser = await info.ctx.get(SecurityBindings.USER, {
        optional: true,
      });
      return result;
    };
    app.bind('hooks.ctx').to(hook).tag(MCP_DISPATCH_HOOK_TAG);
    app.configure('servers.MCPServer').to({
      name: 'hook-test',
      version: '0.0.0',
      transports: {stdio: false},
      localPrincipal: {[securityId]: 'local-user', scopes: ['secret:read']},
    });
    const server = await app.get<MCPServer>('servers.MCPServer');
    await expect(server.callTool('echo', {text: 'hi'})).resolves.toEqual({
      echoed: 'hi',
    });
    // The hook sees a per-request child, never the shared app context.
    expect(observedCtx).toBeDefined();
    expect(observedCtx).not.toBe(app);
    // Principals bound by the wrapped body are visible after next().
    expect(
      (observedUser as Record<symbol, string> | undefined)?.[securityId],
    ).toBe('local-user');
    expect(app.contains(SecurityBindings.USER.key)).toBe(false);
  });

  it('hook results can transform the dispatch result', async () => {
    const app = await givenApp();
    const hook: McpDispatchHook = async (_info, next) => {
      const result = (await next()) as Record<string, unknown>;
      return {...result, wrapped: true};
    };
    app.bind('hooks.wrap').to(hook).tag(MCP_DISPATCH_HOOK_TAG);
    const server = await app.get<MCPServer>('servers.MCPServer');
    await expect(server.callTool('echo', {text: 'hi'})).resolves.toEqual({
      echoed: 'hi',
      wrapped: true,
    });
  });
});
