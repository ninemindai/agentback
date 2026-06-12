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
    this.service(EchoTools);
  }
}
