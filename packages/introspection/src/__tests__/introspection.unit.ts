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
  it('exposes exactly the read-only selector surface', async () => {
    // Deliberately an exact match, not a subset: this package's contract is
    // that it can only READ. A new tool here must be a conscious decision, so
    // adding one is meant to fail this test.
    await using t = await createTestApp(makeApp);
    const {tools} = await t.mcp.listTools();
    const names = tools.map(x => x.name).sort();
    expect(names).toEqual([
      'get',
      'get_okf_bundle',
      'get_okf_files',
      'inventory',
      'list_okf_files',
    ]);
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

  it('list_okf_files summarizes without shipping any bodies', async () => {
    // The whole point: an agent budgets from this instead of pulling the bundle.
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({name: 'list_okf_files', arguments: {}});
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {
      okfVersion: string;
      totalBytes: number;
      files: {path: string; title: string; bytes: number}[];
    };
    expect(out.okfVersion).toBe('0.2');
    expect(out.files.length).toBeGreaterThan(0);
    expect(out.totalBytes).toBeGreaterThan(0);
    for (const f of out.files) {
      expect(f.title).not.toBe('');
      expect(f.bytes).toBeGreaterThan(0);
      expect(f).not.toHaveProperty('content'); // no bodies
    }
    // The summary must be materially smaller than what it summarizes.
    expect(JSON.stringify(out).length).toBeLessThan(out.totalBytes);
  });

  it('get_okf_files returns exactly the requested paths, in order', async () => {
    await using t = await createTestApp(makeApp);
    const list = (
      (await t.mcp.callTool({name: 'list_okf_files', arguments: {}}))
        .structuredContent as {files: {path: string}[]}
    ).files.map(f => f.path);
    const want = [list[list.length - 1], list[0]]; // deliberately not sorted

    const res = await t.mcp.callTool({
      name: 'get_okf_files',
      arguments: {paths: want},
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {
      files: {path: string; content: string}[];
    };
    expect(out.files.map(f => f.path)).toEqual(want);
    for (const f of out.files) expect(f.content.length).toBeGreaterThan(0);
  });

  it('get_okf_files 404s an unknown path and names what exists', async () => {
    // An agent that guessed a path should be able to self-correct from the
    // error rather than having to re-list.
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({
      name: 'get_okf_files',
      arguments: {paths: ['schemas/nope.md']},
    });
    expect(res.isError).toBe(true);
    const {error} = JSON.parse(
      (res.content as {type: string; text: string}[])[0].text,
    );
    expect(error.code).toBe('okf_path_not_found');
    expect(error.hint).toContain('index.md');
  });
});
