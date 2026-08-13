// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Revertible-install conformance for installMcpHttp
 * (docs/proposals/revertible-installs.md, wave 3): uninstall() closes the
 * transport, retracts the /mcp routes on both hosts, and unbinds the
 * `ax.sections.mcp` advertisement.
 */

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {runInstallConformance} from '@agentback/testing';
import {installMcpHttp} from '../../index.js';

const EchoInput = z.object({text: z.string().min(1)});

@mcpServer()
class EchoTools {
  @tool('echo', {description: 'echo back', input: EchoInput})
  echo(input: z.infer<typeof EchoInput>) {
    return {echoed: input.text};
  }
}

async function makeApp(
  rest: Record<string, unknown> = {},
): Promise<RestApplication> {
  const app = new RestApplication({});
  // One configure call: .to() replaces the whole server config (last write
  // wins), so the listener choice must ride along with the ephemeral port.
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1', ...rest});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'uninstall-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(EchoTools);
  await app.get<MCPServer>('servers.MCPServer');
  return app;
}

const rpcProbe = {
  path: '/mcp',
  init: {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
  },
};

// installMcpHttp mounts ONE host per app (rest.listener picks Express vs
// fetch), so the suite runs once per host with a matching app.
runInstallConformance('installMcpHttp (Express host)', {
  makeApp: () => makeApp(),
  install: app => installMcpHttp(app),
  served: [rpcProbe],
  untouched: ['/openapi.json'],
  hosts: ['express'],
});

runInstallConformance('installMcpHttp (fetch host)', {
  makeApp: () => makeApp({listener: 'native'}),
  install: app => installMcpHttp(app),
  served: [rpcProbe],
  untouched: ['/openapi.json'],
});

describe('installMcpHttp uninstall — bindings', () => {
  it('unbinds the ax.sections.mcp advertisement', async () => {
    const app = await makeApp();
    const installed = await installMcpHttp(app);
    await app.start();
    try {
      expect(app.isBound('ax.sections.mcp')).toBe(true);

      await installed.uninstall();

      expect(app.isBound('ax.sections.mcp')).toBe(false);
    } finally {
      await app.stop();
    }
  });
});
