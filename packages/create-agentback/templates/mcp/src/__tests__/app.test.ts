import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {Application} from '../application.js';

describe('{{name}}', () => {
  it('exposes the tools over an in-memory MCP session', async () => {
    await using t = await createTestApp(() => new Application({stdio: false}));
    const tools = await t.mcp.listTools();
    expect(tools.tools.map(x => x.name).sort()).toEqual(['add', 'echo']);
    const out = await t.mcp.callTool({
      name: 'add',
      arguments: {a: 2, b: 3},
    });
    expect(JSON.parse((out.content as {text: string}[])[0].text)).toEqual({
      sum: 5,
    });
  });
});
