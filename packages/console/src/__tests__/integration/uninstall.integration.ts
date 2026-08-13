// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Revertible-install conformance for installConsole
 * (docs/proposals/revertible-installs.md, wave 4): uninstall() retracts the
 * console shell AND every composed feature's footprint — the composition
 * test of the contract, since installConsole is a helper made of helpers.
 */

import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {runInstallConformance} from '@agentback/testing';
import {installConsole} from '../../index.js';

const EchoInput = z.object({text: z.string().min(1)});

@mcpServer()
class EchoTools {
  @tool('echo', {description: 'echo back', input: EchoInput})
  echo(input: z.infer<typeof EchoInput>) {
    return {echoed: input.text};
  }
}

runInstallConformance('installConsole', {
  makeApp: async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'console-uninstall-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(EchoTools);
    await app.get<MCPServer>('servers.MCPServer');
    return app;
  },
  install: app => installConsole(app, {unsafeAllowUnauthenticated: true}),
  served: [
    '/console',
    '/console/',
    '/console/assets/main.js',
    // Feature APIs — each composed feature's footprint must retract too.
    '/context-explorer/api/model',
    '/schema-explorer/api/schemas',
    '/explorer/',
    '/mcp-inspector/api/manifest',
  ],
  untouched: ['/openapi.json'],
});
