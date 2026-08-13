// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {runInstallConformance} from '@agentback/testing';
import {installInspector} from '../../index.js';

const EchoInput = z.object({text: z.string().min(1)});

@mcpServer()
class EchoTools {
  @tool('echo', {description: 'echo back', input: EchoInput})
  echo(input: z.infer<typeof EchoInput>) {
    return {echoed: input.text};
  }
}

async function makeApp(): Promise<RestApplication> {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
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

// With `connect: true` the nested installMcpConnect footprint must retract
// too (mcp-connect is Express-only, so this block probes the Express host).
runInstallConformance('installInspector (with connect)', {
  makeApp,
  install: app => installInspector(app, {connect: true}),
  served: [
    '/mcp-inspector',
    '/mcp-inspector/',
    '/mcp-inspector/api/manifest',
    '/mcp-connect/api/targets',
  ],
  untouched: ['/openapi.json'],
  hosts: ['express'],
});

runInstallConformance('installInspector', {
  makeApp,
  install: app => installInspector(app),
  served: ['/mcp-inspector', '/mcp-inspector/', '/mcp-inspector/api/manifest'],
  untouched: ['/openapi.json'],
});
