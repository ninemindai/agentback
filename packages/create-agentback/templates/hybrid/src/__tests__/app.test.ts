import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {Application} from '../application.js';

describe('{{name}}', () => {
  it('serves the REST route', async () => {
    await using t = await createTestApp(Application);
    const r = await t.http.get('/greet/hello/world').expect(200);
    expect(r.body).toEqual({greeting: 'Hello, world!'});
  });

  it('exposes the MCP tool', async () => {
    await using t = await createTestApp(Application);
    const tools = await t.mcp.listTools();
    expect(tools.tools.map(x => x.name)).toContain('echo');
  });
});
