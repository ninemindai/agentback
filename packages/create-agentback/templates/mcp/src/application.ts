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
    // Register tool classes as controllers, not services: the MCP dispatcher
    // resolves them via `controllers.<name>`, which is the binding that honors
    // constructor `@inject`. A service-bound tool class is `new`-ed without DI,
    // so injected dependencies would be undefined. (`@mcpServer()` tags the
    // class either way, so it's still discovered.)
    this.controller(EchoTools);
  }
}
