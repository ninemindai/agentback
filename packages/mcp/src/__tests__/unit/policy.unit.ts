// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {authorize} from '@agentback/authorization';
import {Context, inject} from '@agentback/context';
import {Client} from '@modelcontextprotocol/client';
import {InMemoryTransport} from '@modelcontextprotocol/server';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {Application} from '@agentback/core';
import {securityId, SecurityBindings} from '@agentback/security';
import type {UserProfile} from '@agentback/security';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer, type ToolBinding} from '../../mcp.server.js';
import {mcpServer, prompt, resource, tool} from '../../decorators/index.js';
import {MCPBindings} from '../../keys.js';
import {authInfoToPrincipals, requiredScopesForTool} from '../../policy.js';
import type {MCPServerConfig} from '../../types.js';

const OrderIn = z.object({what: z.string()});

@mcpServer()
class OrderTools {
  @tool('open', {description: 'ungated tool'})
  open() {
    return {ok: true};
  }

  @authorize({scopes: ['orders:write']})
  @tool('create_order', {input: OrderIn})
  createOrder(input: z.infer<typeof OrderIn>) {
    return {created: input.what};
  }

  @authorize({allowedRoles: ['admin']})
  @tool('admin_only', {input: OrderIn})
  adminOnly(input: z.infer<typeof OrderIn>) {
    return {admin: input.what};
  }

  @tool('whoami')
  whoami(@inject(SecurityBindings.USER, {optional: true}) user?: UserProfile) {
    return {id: user ? user[securityId] : null};
  }

  @tool('legacy', {scope: 'legacy:scope'})
  legacy() {
    return {ok: true};
  }
}

@authorize({scopes: ['class:scope']})
@mcpServer()
class ClassGatedTools {
  @tool('class_gated')
  classGated() {
    return {ok: true};
  }
}

async function givenServer(cfg: Partial<MCPServerConfig> = {}) {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
    ...cfg,
  });
  app.service(OrderTools);
  app.service(ClassGatedTools);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

/** Connect an SDK client to a session built with the given scopes. */
async function clientForScopes(server: MCPServer, scopes?: string[]) {
  const sdkServer = server.buildServer({scopes});
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await sdkServer.connect(serverTransport);
  const client = new Client({name: 'test-client', version: '0.0.0'});
  await client.connect(clientTransport);
  return client;
}

describe('authInfoToPrincipals', () => {
  it('passes through framework principals from authInfo.extra', () => {
    const user = {[securityId]: 'u1', scopes: ['a']} as UserProfile;
    const info = {
      token: 't',
      clientId: 'c1',
      scopes: ['a'],
      extra: {user},
    } as AuthInfo;
    expect(authInfoToPrincipals(info).user).toBe(user);
  });

  it('synthesizes a principal from raw OAuth claims', () => {
    const info = {
      token: 't',
      clientId: 'svc-1',
      scopes: ['x', 'y'],
    } as AuthInfo;
    const {user} = authInfoToPrincipals(info);
    expect(user?.[securityId]).toBe('svc-1');
    expect(user?.scopes).toEqual(['x', 'y']);
  });
});

describe('requiredScopesForTool', () => {
  const toolMeta = (server: MCPServer, name: string): ToolBinding =>
    server.listTools().find(t => t.meta.name === name)!;

  it('@authorize scopes gate visibility', async () => {
    const {server} = await givenServer();
    const t = toolMeta(server, 'create_order');
    expect(requiredScopesForTool(t.ctor, t.meta)).toEqual(['orders:write']);
  });

  it('legacy @tool scope still gates', async () => {
    const {server} = await givenServer();
    const t = toolMeta(server, 'legacy');
    expect(requiredScopesForTool(t.ctor, t.meta)).toEqual(['legacy:scope']);
  });

  it('roles-only metadata does not affect visibility', async () => {
    const {server} = await givenServer();
    const t = toolMeta(server, 'admin_only');
    expect(requiredScopesForTool(t.ctor, t.meta)).toEqual([]);
  });

  it('class-level @authorize applies to tools', async () => {
    const {server} = await givenServer();
    const t = toolMeta(server, 'class_gated');
    expect(requiredScopesForTool(t.ctor, t.meta)).toEqual(['class:scope']);
  });
});

describe('tool visibility per session scopes', () => {
  it('hides scope-gated tools from sessions lacking the scope', async () => {
    const {server} = await givenServer();
    const client = await clientForScopes(server, ['something:else']);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual(['admin_only', 'open', 'whoami']);
  });

  it('shows scope-gated tools when the session holds the scope', async () => {
    const {server} = await givenServer();
    const client = await clientForScopes(server, [
      'orders:write',
      'class:scope',
      'legacy:scope',
    ]);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    expect(names).toEqual([
      'admin_only',
      'class_gated',
      'create_order',
      'legacy',
      'open',
      'whoami',
    ]);
  });

  it('registers everything for unauthenticated transports (stdio)', async () => {
    const {server} = await givenServer();
    const client = await clientForScopes(server, undefined);
    expect((await client.listTools()).tools).toHaveLength(6);
  });
});

describe('call-time authorization', () => {
  it('denies an @authorize-gated tool with no principal', async () => {
    const {server} = await givenServer();
    await expect(server.callTool('create_order', {what: 'x'})).rejects.toThrow(
      /Forbidden: not authorized for OrderTools.createOrder/,
    );
  });

  it('allows when localPrincipal carries the scope', async () => {
    const {server} = await givenServer({
      localPrincipal: {[securityId]: 'local', scopes: ['orders:write']},
    });
    await expect(server.callTool('create_order', {what: 'x'})).resolves.toEqual(
      {created: 'x'},
    );
  });

  it('denies roles-gated tools for principals without the role', async () => {
    const {server} = await givenServer({
      localPrincipal: {[securityId]: 'local', scopes: ['orders:write']},
    });
    await expect(server.callTool('admin_only', {what: 'x'})).rejects.toThrow(
      /Forbidden/,
    );
  });

  it('allows roles-gated tools for principals with the role', async () => {
    const {server} = await givenServer({
      localPrincipal: {[securityId]: 'local', roles: ['admin']},
    });
    await expect(server.callTool('admin_only', {what: 'x'})).resolves.toEqual({
      admin: 'x',
    });
  });

  it('tools without @authorize stay callable (regression)', async () => {
    const {server} = await givenServer();
    await expect(server.callTool('open', {})).resolves.toEqual({ok: true});
  });

  it('authorizes before input validation', async () => {
    const {server} = await givenServer();
    // Invalid input AND missing scope: the error must be Forbidden, not a
    // validation error — unauthorized callers learn nothing about the schema.
    await expect(server.callTool('create_order', {})).rejects.toThrow(
      /Forbidden/,
    );
  });
});

describe('per-request principal isolation', () => {
  type Dispatch = (
    tool: ToolBinding,
    input: unknown,
    ctx?: Context,
  ) => Promise<unknown>;

  const dispatchAs = async (
    app: Application,
    server: MCPServer,
    clientId: string,
  ) => {
    const t = server.listTools().find(x => x.meta.name === 'whoami')!;
    const ctx = new Context(app, 'mcp.request');
    ctx.bind(MCPBindings.REQUEST_AUTH).to({
      token: 't',
      clientId,
      scopes: [],
    } as unknown as AuthInfo);
    const dispatch = (
      server as unknown as {dispatchTool: Dispatch}
    ).dispatchTool.bind(server) as Dispatch;
    return dispatch(t, {}, ctx);
  };

  it('two calls with different principals never see each other', async () => {
    const {app, server} = await givenServer();
    const [a, b] = await Promise.all([
      dispatchAs(app, server, 'caller-a'),
      dispatchAs(app, server, 'caller-b'),
    ]);
    expect(a).toEqual({id: 'caller-a'});
    expect(b).toEqual({id: 'caller-b'});
  });

  it('never binds principals into the shared app context', async () => {
    const {app, server} = await givenServer({
      localPrincipal: {[securityId]: 'local', scopes: ['orders:write']},
    });
    await server.callTool('create_order', {what: 'x'});
    expect(app.contains(SecurityBindings.USER.key)).toBe(false);
  });
});

// ---- resources & prompts under @authorize ----

@mcpServer()
class GatedContent {
  @authorize({scopes: ['docs:read']})
  @resource('docs://secret', {name: 'secret_doc', description: 'gated'})
  secretDoc() {
    return 'classified';
  }

  @resource('docs://public', {name: 'public_doc'})
  publicDoc() {
    return 'open';
  }

  @authorize({scopes: ['prompts:use']})
  @prompt('gated_prompt', {description: 'gated'})
  gatedPrompt() {
    return 'hello agent';
  }

  @prompt('open_prompt')
  openPrompt() {
    return 'hi';
  }
}

async function givenContentServer(cfg: Partial<MCPServerConfig> = {}) {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
    ...cfg,
  });
  app.service(GatedContent);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

describe('resource/prompt visibility per session scopes', () => {
  it('hides scope-gated resources and prompts from sessions lacking scopes', async () => {
    const {server} = await givenContentServer();
    const client = await clientForScopes(server, ['other:scope']);
    const resources = await client.listResources();
    expect(resources.resources.map(r => r.name)).toEqual(['public_doc']);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(p => p.name)).toEqual(['open_prompt']);
  });

  it('shows them when the session holds the scopes', async () => {
    const {server} = await givenContentServer();
    const client = await clientForScopes(server, ['docs:read', 'prompts:use']);
    const resources = await client.listResources();
    expect(resources.resources.map(r => r.name).sort()).toEqual([
      'public_doc',
      'secret_doc',
    ]);
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(p => p.name).sort()).toEqual([
      'gated_prompt',
      'open_prompt',
    ]);
  });
});

describe('resource/prompt call-time authorization', () => {
  it('denies gated members with no principal (inspector path)', async () => {
    const {server} = await givenContentServer();
    await expect(server.readResource('secret_doc')).rejects.toThrow(
      /Forbidden: not authorized for GatedContent.secretDoc/,
    );
    await expect(server.getPrompt('gated_prompt')).rejects.toThrow(
      /Forbidden: not authorized for GatedContent.gatedPrompt/,
    );
  });

  it('allows when localPrincipal carries the scopes', async () => {
    const {server} = await givenContentServer({
      localPrincipal: {
        [securityId]: 'local',
        scopes: ['docs:read', 'prompts:use'],
      },
    });
    const doc = await server.readResource('secret_doc');
    expect(doc.contents[0].text).toBe('classified');
    const p = await server.getPrompt('gated_prompt');
    expect(p.messages[0].content.text).toBe('hello agent');
  });

  it('ungated members stay readable (regression)', async () => {
    const {server} = await givenContentServer();
    const doc = await server.readResource('public_doc');
    expect(doc.contents[0].text).toBe('open');
    const p = await server.getPrompt('open_prompt');
    expect(p.messages[0].content.text).toBe('hi');
  });

  it('never binds principals into the shared app context', async () => {
    const {app, server} = await givenContentServer({
      localPrincipal: {[securityId]: 'local', scopes: ['docs:read']},
    });
    await server.readResource('secret_doc');
    expect(app.contains(SecurityBindings.USER.key)).toBe(false);
  });
});
