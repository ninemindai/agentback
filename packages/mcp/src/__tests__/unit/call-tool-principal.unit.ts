// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {authorize} from '@agentback/authorization';
import {Context, inject} from '@agentback/context';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {Application} from '@agentback/core';
import {securityId, SecurityBindings} from '@agentback/security';
import type {UserProfile} from '@agentback/security';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';
import {MCPBindings} from '../../keys.js';
import type {MCPServerConfig} from '../../types.js';

const OrderIn = z.object({what: z.string()});

@mcpServer()
class SeamTools {
  @authorize({allowedRoles: ['admin']})
  @tool('admin_only', {input: OrderIn})
  adminOnly(input: z.infer<typeof OrderIn>) {
    return {admin: input.what};
  }

  @tool('whoami')
  whoami(@inject(SecurityBindings.USER, {optional: true}) user?: UserProfile) {
    return {id: user ? user[securityId] : null};
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
  app.service(SeamTools);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

const admin = {
  [securityId]: 'admin-1',
  roles: ['admin'],
} as unknown as UserProfile;

describe('callTool {principal} seam', () => {
  it('authorizes an @authorize-guarded tool under the passed principal', async () => {
    const {server} = await givenServer();
    // Without a principal the voter rejects…
    await expect(server.callTool('admin_only', {what: 'x'})).rejects.toThrow(
      /denied|authoriz/i,
    );
    // …with the explicit per-call principal it executes.
    const result = await server.callTool(
      'admin_only',
      {what: 'x'},
      {principal: admin},
    );
    expect(result).toEqual({admin: 'x'});
  });

  it('binds the explicit principal as SecurityBindings.USER for @inject', async () => {
    const {server} = await givenServer();
    const result = await server.callTool('whoami', {}, {principal: admin});
    expect(result).toEqual({id: 'admin-1'});
  });

  it('uses the pre-resolved {binding} instead of scanning by name', async () => {
    const {server} = await givenServer();
    const binding = server.listTools().find(t => t.meta.name === 'whoami')!;
    // A name that matches no registered tool proves the binding was used.
    const result = await server.callTool(
      'not-a-registered-name',
      {},
      {binding, principal: admin},
    );
    expect(result).toEqual({id: 'admin-1'});
  });

  it('chains request state from the provided {ctx} parent', async () => {
    const {app, server} = await givenServer();
    // A turn context off the app context, carrying the turn's principal the
    // way the agents turn wrapper binds it.
    const turn = new Context(app, 'agent.turn');
    turn.bind(SecurityBindings.USER).to(admin);
    // The per-call request child is a child of `turn`, so the @inject chain
    // walk finds the turn-scoped USER binding.
    const result = await server.callTool('whoami', {}, {ctx: turn});
    expect(result).toEqual({id: 'admin-1'});
  });

  // REGRESSION (test 6 in the plan matrix): no options → existing behavior.
  it('REGRESSION: no options keeps localPrincipal/anonymous behavior', async () => {
    const anonymous = await givenServer();
    expect(await anonymous.server.callTool('whoami', {})).toEqual({id: null});

    const local = await givenServer({
      localPrincipal: {[securityId]: 'local-dev'} as unknown as UserProfile,
    });
    expect(await local.server.callTool('whoami', {})).toEqual({
      id: 'local-dev',
    });
  });

  // REGRESSION (test 7): transport auth always wins over the explicit principal.
  it('REGRESSION: REQUEST_AUTH still wins over an explicit principal', async () => {
    const {server} = await givenServer();
    const authedUser = {
      [securityId]: 'transport-user',
      roles: ['admin'],
    } as unknown as UserProfile;
    const turn = new Context(
      (server as unknown as {context: Context})['context'],
      'mcp.session',
    );
    turn.bind(MCPBindings.REQUEST_AUTH).to({
      token: 't',
      clientId: 'c1',
      scopes: [],
      extra: {user: authedUser},
    } as AuthInfo);
    const result = await server.callTool(
      'whoami',
      {},
      {ctx: turn, principal: admin},
    );
    // The transport-authenticated user, not the explicit one.
    expect(result).toEqual({id: 'transport-user'});
  });

  // REGRESSION: explicit principal does not leak across calls.
  it('REGRESSION: the explicit principal is per-call, never cached', async () => {
    const {server} = await givenServer();
    expect(await server.callTool('whoami', {}, {principal: admin})).toEqual({
      id: 'admin-1',
    });
    expect(await server.callTool('whoami', {})).toEqual({id: null});
  });
});
