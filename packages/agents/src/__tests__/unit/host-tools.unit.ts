// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {authorize} from '@agentback/authorization';
import {Application} from '@agentback/core';
import {MCPComponent, mcpServer, tool, type MCPServer} from '@agentback/mcp';
import {filterTools, isProjectedTool, toHostTools} from '../../host-tools.js';

const EchoIn = z.object({text: z.string()});

@mcpServer()
class KitchenSinkTools {
  @tool('echo', {description: 'Echo.', input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('open')
  open() {
    return {ok: true};
  }

  @authorize({scopes: ['admin:ops']})
  @tool('admin_op', {description: 'Scoped.'})
  adminOp() {
    return {ok: true};
  }

  @tool('dangerous', {confirm: true})
  dangerous() {
    return {done: true};
  }
}

async function givenApp() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(KitchenSinkTools);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

describe('filterTools', () => {
  it('include/exclude filter by name (confirm: tools skipped silently)', async () => {
    const {server} = await givenApp();
    const all = server.listTools();
    expect(filterTools(all).map(t => t.meta.name)).toEqual([
      'echo',
      'open',
      'admin_op',
    ]);
    expect(filterTools(all, {include: ['echo']}).map(t => t.meta.name)).toEqual(
      ['echo'],
    );
    expect(
      filterTools(all, {exclude: ['echo', 'admin_op']}).map(t => t.meta.name),
    ).toEqual(['open']);
  });

  it('throws on include/exclude names matching no tool, listing available', async () => {
    const {server} = await givenApp();
    // The classic typo: the error must name the bad entry AND what exists.
    expect(() => filterTools(server.listTools(), {include: ['ecoh']})).toThrow(
      /match no registered tool: ecoh.*Available: .*echo/s,
    );
    expect(() => filterTools(server.listTools(), {exclude: ['nope']})).toThrow(
      /match no registered tool: nope/,
    );
  });

  it('throws on duplicate tool names', () => {
    const t = (name: string) => ({
      ctor: KitchenSinkTools,
      meta: {name, methodName: 'echo'},
    });
    expect(() => filterTools([t('dup'), t('dup')])).toThrow(
      /duplicate tool name\(s\): dup/,
    );
  });

  it('throws when an include list names a confirm: tool', async () => {
    const {server} = await givenApp();
    expect(() =>
      filterTools(server.listTools(), {include: ['dangerous']}),
    ).toThrow(/confirm: tool/);
  });

  it('throws on provider-illegal tool names', () => {
    const bad = {
      ctor: KitchenSinkTools,
      meta: {name: 'has spaces!', methodName: 'echo'},
    };
    expect(() => filterTools([bad])).toThrow(/provider tool-calling/);
  });

  it('applies the scope gate before include/exclude', async () => {
    const {server} = await givenApp();
    const all = server.listTools();
    // No 'admin:ops' scope → admin_op is not visible…
    expect(filterTools(all, {scopes: ['other']}).map(t => t.meta.name)).toEqual(
      ['echo', 'open'],
    );
    // …and explicitly including it names the visibility problem.
    expect(() =>
      filterTools(all, {scopes: ['other'], include: ['admin_op']}),
    ).toThrow(/match no visible tool/);
    // With the scope, it projects.
    expect(
      filterTools(all, {scopes: ['admin:ops'], include: ['admin_op']}).map(
        t => t.meta.name,
      ),
    ).toEqual(['admin_op']);
  });
});

describe('toHostTools', () => {
  it('projects tools with the Zod input passed through and marks them', async () => {
    const {app} = await givenApp();
    const tools = await toHostTools(app, {include: ['echo', 'open']});
    expect(Object.keys(tools).sort()).toEqual(['echo', 'open']);
    const echo = tools.echo as {inputSchema: unknown; execute: Function};
    // The @tool's Zod object IS the AI SDK inputSchema — same source of truth.
    expect(echo.inputSchema).toBe(EchoIn);
    expect(isProjectedTool(tools.echo)).toBe(true);
    expect(isProjectedTool({})).toBe(false);
    // No input schema → open-object JSON schema fallback, not undefined.
    const open = tools.open as {inputSchema: unknown};
    expect(open.inputSchema).toBeDefined();
    expect(open.inputSchema).not.toBe(EchoIn);
  });

  it('execute returns the unwrapped tool result (no MCP envelope)', async () => {
    const {app} = await givenApp();
    const tools = await toHostTools(app, {include: ['echo']});
    const echo = tools.echo as {
      execute: (input: unknown, options?: unknown) => Promise<unknown>;
    };
    const result = await echo.execute({text: 'hi'});
    expect(result).toEqual({echoed: 'hi'});
  });

  it('works before app.start() (the README snippet ordering)', async () => {
    // givenApp never called app.start() — reaching here proves the ordering.
    const {app} = await givenApp();
    const tools = await toHostTools(app);
    expect(Object.keys(tools).length).toBeGreaterThan(0);
  });
});
