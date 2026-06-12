import {Application as CoreApplication} from '@agentback/core';
import {MCPComponent} from '@agentback/mcp';
import {EchoTools} from './tools/echo.tools.js';

export class Application extends CoreApplication {
  constructor(options: {stdio?: boolean} = {}) {
    super();
    this.component(MCPComponent);
    this.configure('servers.MCPServer').to({
      name: '{{name}}',
      version: '0.1.0',
      transports: {stdio: options.stdio ?? true},
    });
    // A tool class is a DI service. The MCP server discovers it by the
    // `@mcpServer` tag and resolves it (with constructor `@inject`) through its
    // binding, so any constructor dependencies are injected.
    this.service(EchoTools);
  }
}
