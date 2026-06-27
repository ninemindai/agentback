// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {IntrospectionTools} from '../index.js';

function makeApp(): RestApplication {
  const app = new RestApplication({rest: {port: 0}});
  app.component(MCPComponent);
  app.service(IntrospectionTools);
  app.bind('secret.token').to('SUPER_SECRET_VALUE');
  return app;
}

describe('introspection MCP', () => {
  it('exposes exactly the three read tools', async () => {
    await using t = await createTestApp(makeApp);
    const {tools} = await t.mcp.listTools();
    const names = tools.map(x => x.name).sort();
    expect(names).toEqual(['get', 'get_okf_bundle', 'inventory']);
  });

  it('inventory returns the binding node and never leaks its value', async () => {
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({name: 'inventory', arguments: {}});
    // Assert the call SUCCEEDED and returned the node — otherwise the no-leak
    // check below would pass vacuously on an errored/empty response.
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {nodes: {kind: string; id: string}[]};
    expect(
      out.nodes.some(n => n.kind === 'binding' && n.id === 'secret.token'),
    ).toBe(true);
    expect(JSON.stringify(res)).not.toContain('SUPER_SECRET_VALUE');
  });

  it('get on a secret binding returns metadata only (hostile no-leak)', async () => {
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({
      name: 'get',
      arguments: {kind: 'binding', id: 'secret.token'},
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {detail: {key: string}};
    expect(out.detail.key).toBe('secret.token'); // metadata IS returned
    expect(JSON.stringify(res)).not.toContain('SUPER_SECRET_VALUE'); // value is NOT
  });

  it('get_okf_bundle returns a file set', async () => {
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({
      name: 'get_okf_bundle',
      arguments: {},
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {files: unknown[]};
    expect(Array.isArray(out.files)).toBe(true);
  });
});
