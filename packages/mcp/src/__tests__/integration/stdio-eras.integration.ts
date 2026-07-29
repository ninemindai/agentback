// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

// stdio can only be tested honestly by spawning a real child process: the
// transport IS the process's stdin/stdout, so an in-process harness would prove
// nothing about it.
//
// `protocol: 'both'` routes stdio through the SDK's `serveStdio`, where the
// OPENING exchange picks the era and one instance is pinned for the connection
// (unlike HTTP, which constructs per request). These tests drive the same
// server binary with a modern-negotiating client and a legacy client.

// Inside the package (under dist/, which is gitignored) rather than os.tmpdir():
// a bare `zod` import only resolves if the script sits where Node can walk up
// to the workspace's node_modules.
const dir = join(import.meta.dirname, 'stdio-fixtures');

/** Write a tiny server that boots MCPServer over stdio with the given config. */
function serverScript(protocol: 'legacy' | 'both'): string {
  const file = join(dir, `server-${protocol}.mjs`);
  const repo = join(import.meta.dirname, '..', '..', '..', '..', '..');
  writeFileSync(
    file,
    `
import {Application} from '${join(repo, 'packages/core/dist/index.js')}';
import {MCPComponent, mcpServer, tool} from '${join(repo, 'packages/mcp/dist/index.js')}';
import {z} from 'zod';

const EchoIn = z.object({text: z.string()});

// Decorators are applied as plain calls: this file is a real .mjs run by node,
// which has no decorator syntax.
class Tools {
  echo(input) { return {echoed: input.text}; }
}
tool('echo', {input: EchoIn})(Tools.prototype, 'echo',
  Object.getOwnPropertyDescriptor(Tools.prototype, 'echo'));
mcpServer()(Tools);

const app = new Application();
app.component(MCPComponent);
app.configure('servers.MCPServer').to({
  name: 'stdio-test', version: '0.0.0',
  protocol: ${JSON.stringify(protocol)},
  transports: {stdio: true},
});
app.service(Tools);
await app.start();
`,
  );
  return file;
}

async function connect(script: string, modern: boolean) {
  const client = new Client(
    {name: 'c', version: '0.0.0'},
    modern ? {versionNegotiation: {mode: 'auto' as const}} : {},
  );
  await client.connect(
    new StdioClientTransport({command: process.execPath, args: [script]}),
  );
  return client;
}

describe('stdio protocol eras', () => {
  let both: string;
  let legacy: string;

  beforeAll(() => {
    mkdirSync(dir, {recursive: true});
    both = serverScript('both');
    legacy = serverScript('legacy');
  });
  afterAll(() => rmSync(dir, {recursive: true, force: true}));

  it("serves the modern era when protocol is 'both'", async () => {
    const client = await connect(both, true);
    expect(client.getProtocolEra()).toBe('modern');
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name)).toContain('echo');
    const res = await client.callTool({
      name: 'echo',
      arguments: {text: 'stdio-modern'},
    });
    expect(JSON.stringify(res.content)).toContain('stdio-modern');
    await client.close();
  }, 30_000);

  it("still serves a 2025-era client when protocol is 'both'", async () => {
    // The pinned-era promise: one binary, either client works.
    const client = await connect(both, false);
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.map(t => t.name)).toContain('echo');
    await client.close();
  }, 30_000);

  it('stays 2025-only by default', async () => {
    // The default must not have moved: an auto-negotiating client probes,
    // finds no modern support, and falls back rather than failing.
    const client = await connect(legacy, true);
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.map(t => t.name)).toContain('echo');
    await client.close();
  }, 30_000);
});
