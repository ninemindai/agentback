import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {Application} from '../application.js';
import {claudeDomain, widgetDomain} from '../widget/claude-domain.js';

describe('MCP Apps widget', () => {
  it('links show_greeting to its ui:// widget', async () => {
    await using t = await createTestApp(Application);
    const {tools} = await t.mcp.listTools();
    const tool = tools.find(x => x.name === 'show_greeting');
    expect(tool?._meta).toEqual({ui: {resourceUri: 'ui://widgets/greeting'}});
    const out = await t.mcp.callTool({
      name: 'show_greeting',
      arguments: {name: 'world'},
    });
    expect(out.structuredContent).toEqual({greeting: 'Hello, world!'});
  });

  it('serves the bundled widget with the mcp-app MIME type', async () => {
    await using t = await createTestApp(Application);
    const {contents} = await t.mcp.readResource({
      uri: 'ui://widgets/greeting',
    });
    expect(contents[0].mimeType).toBe('text/html;profile=mcp-app');
    const text = (contents[0] as {text: string}).text;
    expect(text).toContain('<!doctype html>');
    expect(text).not.toContain('/*__VIEW_BUNDLE__*/');
  });

  it('derives the Claude widget domain from PUBLIC_URL', () => {
    expect(widgetDomain(undefined)).toBeUndefined();
    expect(widgetDomain('https://example.com')).toBe(
      claudeDomain('https://example.com/mcp'),
    );
    expect(claudeDomain('https://example.com/mcp')).toMatch(
      /^[0-9a-f]{32}\.claudemcpcontent\.com$/,
    );
  });
});
