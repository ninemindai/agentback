// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/mcp
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {inject} from '@agentback/context';
import {Application, extensionFor} from '@agentback/core';
import {MCP_SERVERS} from '../../keys.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';

const NoInput = z.object({});

class Greeter {
  hello() {
    return 'injected';
  }
}

@mcpServer()
class InjectedTools {
  constructor(@inject('services.greeter') private greeter: Greeter) {}

  @tool('greet', {input: NoInput})
  greet(_input: z.infer<typeof NoInput>) {
    return {msg: this.greeter.hello()};
  }
}

async function serverWith(
  register: (app: Application) => void,
): Promise<MCPServer> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'inject-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.bind('services.greeter').toClass(Greeter);
  register(app);
  return app.get<MCPServer>('servers.MCPServer');
}

// A tool class is discovered by its `@mcpServer` tag and resolved through that
// same binding — so constructor `@inject` is honored no matter which namespace
// it was registered in. Before the fix, a `service`-bound tool was `new`-ed
// with no DI and `this.greeter` came back `undefined`.
describe('MCP tool constructor injection is namespace-independent', () => {
  it('injects via app.service()', async () => {
    const server = await serverWith(app => app.service(InjectedTools));
    expect(await server.callTool('greet', {})).toEqual({msg: 'injected'});
  });

  it('injects via app.controller()', async () => {
    const server = await serverWith(app => app.controller(InjectedTools));
    expect(await server.callTool('greet', {})).toEqual({msg: 'injected'});
  });

  it('injects via a manual bind().apply(extensionFor(MCP_SERVERS))', async () => {
    const server = await serverWith(app =>
      app
        .bind('tools.injected')
        .toClass(InjectedTools)
        .apply(extensionFor(MCP_SERVERS)),
    );
    expect(await server.callTool('greet', {})).toEqual({msg: 'injected'});
  });
});
