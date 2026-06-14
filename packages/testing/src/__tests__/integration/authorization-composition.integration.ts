// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {
  MCPComponent,
  mcpServer,
  prompt,
  resource,
  tool,
} from '@agentback/mcp';
import {authorize} from '@agentback/authorization';
import {securityId} from '@agentback/security';
import {createTestApp} from '../../test-app.js';

/**
 * The capstone invariant: ONE `@authorize` declaration on a hybrid class
 * governs every surface that class exposes — REST routes, MCP tools, MCP
 * resources, and MCP prompts — consistently. A regression where any single
 * surface silently skipped the gate would be a security hole; this test
 * catches it across all four at once.
 *
 * (The route and tool are separate methods by necessity: a REST handler's
 * slot 0 is the `{body, path, …}` bundle while a tool's is the raw
 * `z.infer<input>`, so a single method can't carry both typed decorators.
 * The single *declaration* is the class-level `@authorize`.)
 */

const Data = z.object({secret: z.string()});
const Empty = z.object({});

// Class-level @authorize: every member requires the `admin` scope.
@authorize({scopes: ['admin']})
@api({basePath: '/secure'})
@mcpServer()
class SecureController {
  @get('/data', {response: Data})
  async getData(): Promise<z.infer<typeof Data>> {
    return {secret: 'classified'};
  }

  @tool('get_data', {input: Empty, output: Data})
  async getDataTool(
    _input: z.infer<typeof Empty>,
  ): Promise<z.infer<typeof Data>> {
    return {secret: 'classified'};
  }

  @resource('secure://doc', {name: 'secure_doc'})
  doc() {
    return 'classified';
  }

  @prompt('secure_prompt')
  securePrompt() {
    return 'classified';
  }
}

// A second, ungated controller proves the gate is opt-in — an undecorated
// class is reachable on every surface, no regression. It also keeps the
// resources/prompts capabilities present even when the gated members are
// filtered out (an MCP server advertises a capability only when it has ≥1
// member of that kind), so the "hidden" assertions can list them.
@api({basePath: '/open'})
@mcpServer()
class OpenController {
  @get('/data', {response: Data})
  async data(): Promise<z.infer<typeof Data>> {
    return {secret: 'public'};
  }

  @tool('open_data', {input: Empty, output: Data})
  async dataTool(_input: z.infer<typeof Empty>): Promise<z.infer<typeof Data>> {
    return {secret: 'public'};
  }

  @resource('open://doc', {name: 'open_doc'})
  doc() {
    return 'public';
  }

  @prompt('open_prompt')
  openPrompt() {
    return 'public';
  }
}

class SecureApp extends RestApplication {
  constructor(localAdmin = false) {
    super({});
    this.component(MCPComponent);
    this.configure('servers.MCPServer').to({
      name: 'secure',
      version: '0.0.0',
      transports: {stdio: false},
      ...(localAdmin
        ? {localPrincipal: {[securityId]: 'svc', scopes: ['admin']}}
        : {}),
    });
    // A dual `@api` + `@mcpServer` class needs only ONE registration: the
    // additive `restController` keeps the class's `extensionFor(MCP_SERVERS)`
    // membership, so REST (via the `restController` tag) and MCP (via the
    // extension membership) both discover it from a single binding.
    this.restController(SecureController);
    this.restController(OpenController);
  }
}

describe('one @authorize, every surface', () => {
  it('REST: the gated route is forbidden, an ungated route is open', async () => {
    const t = await createTestApp(() => new SecureApp());
    try {
      await t.http.get('/secure/data').expect(403);
      const open = await t.http.get('/open/data').expect(200);
      expect(open.body).toEqual({secret: 'public'});
    } finally {
      await t.stop();
    }
  });

  it('MCP: tool, resource, and prompt are all denied without the scope', async () => {
    // mcpScopes carries the scope so the members are VISIBLE — proving the
    // denial is call-time enforcement, not just visibility filtering.
    const t = await createTestApp(() => new SecureApp(), {
      mcpScopes: ['admin'],
    });
    try {
      const tools = await t.mcp.listTools();
      expect(tools.tools.map(x => x.name)).toContain('get_data');

      const call = await t.mcp.callTool({name: 'get_data', arguments: {}});
      expect((call as {isError?: boolean}).isError).toBe(true);

      await expect(t.mcp.readResource({uri: 'secure://doc'})).rejects.toThrow(
        /Forbidden/,
      );
      await expect(t.mcp.getPrompt({name: 'secure_prompt'})).rejects.toThrow(
        /Forbidden/,
      );
    } finally {
      await t.stop();
    }
  });

  it('MCP: all three surfaces allow once the principal carries the scope', async () => {
    const t = await createTestApp(() => new SecureApp(true), {
      mcpScopes: ['admin'],
    });
    try {
      const call = await t.mcp.callTool({name: 'get_data', arguments: {}});
      expect(
        (call as {structuredContent?: {secret: string}}).structuredContent,
      ).toEqual({secret: 'classified'});

      const res = await t.mcp.readResource({uri: 'secure://doc'});
      expect((res.contents[0] as {text: string}).text).toBe('classified');

      const p = await t.mcp.getPrompt({name: 'secure_prompt'});
      expect(p.messages).toHaveLength(1);
    } finally {
      await t.stop();
    }
  });

  it('MCP: scope-gated members are hidden from sessions lacking the scope', async () => {
    const t = await createTestApp(() => new SecureApp(), {mcpScopes: []});
    try {
      const tools = (await t.mcp.listTools()).tools.map(x => x.name);
      expect(tools).not.toContain('get_data');
      expect(tools).toContain('open_data'); // ungated sibling stays visible
      const resources = (await t.mcp.listResources()).resources.map(
        r => r.name,
      );
      expect(resources).not.toContain('secure_doc');
      expect(resources).toContain('open_doc');
      const prompts = (await t.mcp.listPrompts()).prompts.map(x => x.name);
      expect(prompts).not.toContain('secure_prompt');
      expect(prompts).toContain('open_prompt');
    } finally {
      await t.stop();
    }
  });
});
