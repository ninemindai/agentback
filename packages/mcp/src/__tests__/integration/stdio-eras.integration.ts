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
function serverScript(protocol: 'legacy' | 'both' | undefined): string {
  mkdirSync(dir, {recursive: true});
  const file = join(dir, `server-${protocol ?? 'default'}.mjs`);
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
  ${protocol === undefined ? '' : `protocol: ${JSON.stringify(protocol)},`}
  transports: {stdio: true},
});
app.service(Tools);
await app.start();
// Graceful-shutdown probe: the parent sends SIGUSR2, we stop() and report.
// This is the only way to exercise stop() on a real stdio server — the normal
// tests let the client disconnect, which kills the child without ever calling it.
process.on('SIGUSR2', async () => {
  const t = setTimeout(() => { console.error('STOP_HUNG'); process.exit(3); }, 5000);
  await app.stop();
  clearTimeout(t);
  console.error('STOP_OK');
  process.exit(0);
});
// Announced only AFTER the handler is installed, so the parent can never
// signal into a window where nothing is listening. stdout is the MCP transport
// under serveStdio, so readiness goes to stderr.
console.error('READY');
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
    both = serverScript('both');
    legacy = serverScript('legacy');
  });

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

  it("serves 2025 only when pinned to protocol: 'legacy'", async () => {
    // The rollback switch. An auto-negotiating client probes, finds no modern
    // support, and falls back rather than failing — so pinning back is safe
    // for clients that already moved on.
    //
    // This test used to be called "stays 2025-only by default" and asserted
    // the same thing. The default moved to 'both' in 0.9.0; the assertion is
    // still right but it is now about an explicit opt-out, not a default, and
    // a name that says otherwise is worse than no name.
    const client = await connect(legacy, true);
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.map(t => t.name)).toContain('echo');
    await client.close();
  }, 30_000);

  it('serves the modern era with no `protocol` set at all', async () => {
    // The flip itself. Nothing but `transports: {stdio: true}` configured.
    const client = await connect(serverScript(undefined), true);
    expect(client.getProtocolEra()).toBe('modern');
    expect((await client.listTools()).tools.map(t => t.name)).toContain('echo');
    await client.close();
  }, 30_000);

  it('still serves a 2025 client with no `protocol` set', async () => {
    // The half that makes the flip safe: the default must not drop anyone.
    const client = await connect(serverScript(undefined), false);
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.map(t => t.name)).toContain('echo');
    await client.close();
  }, 30_000);
});

// `MCPServer.stop()` under `protocol: 'both'` must close the handle `serveStdio`
// returned. Nothing else covers it: the era tests let the client disconnect,
// which kills the child before stop() is ever reached. If the handle is not
// closed, a graceful shutdown hangs — invisible until a deploy fails to drain.
describe('stdio graceful shutdown', () => {
  for (const mode of ['both', 'legacy'] as const) {
    it(`stop() completes under protocol: '${mode}'`, async () => {
      const {spawn} = await import('node:child_process');
      const child = spawn(process.execPath, [serverScript(mode)], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', d => (stderr += String(d)));

      // Wait for the child to announce its handler is installed. A fixed sleep
      // here is exactly the flake CI caught: on a loaded runner the signal
      // arrived before start() finished and was silently lost.
      const ready = await new Promise<boolean>(resolve => {
        const t = setTimeout(() => resolve(false), 15_000);
        const check = () => {
          if (stderr.includes('READY')) {
            clearTimeout(t);
            resolve(true);
          }
        };
        child.stderr.on('data', check);
        check();
      });
      expect(ready).toBe(true);
      child.kill('SIGUSR2');

      const code: number = await new Promise(resolve => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve(-1); // never exited: stop() hung
        }, 10_000);
        child.on('exit', c => {
          clearTimeout(t);
          resolve(c ?? -1);
        });
      });

      expect(stderr).not.toContain('STOP_HUNG');
      expect(stderr).toContain('STOP_OK');
      expect(code).toBe(0);
    }, 30_000);
  }
});

// Fixtures are shared by both describes above, so clean up once at the end.
afterAll(() => rmSync(dir, {recursive: true, force: true}));
