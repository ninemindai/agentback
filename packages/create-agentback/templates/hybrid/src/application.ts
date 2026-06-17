// {{agentback:imports}}
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {GreetingController} from './controllers/greeting.controller.js';

export class Application extends RestApplication {
  constructor() {
    super({/* {{agentback:rest-config}} */});
    this.component(MCPComponent);
    this.configure('servers.MCPServer').to({
      name: '{{name}}',
      version: '0.1.0',
      transports: {stdio: false},
    });
    // {{agentback:components}}
    // One class, two surfaces — both registrations are needed. `restController`
    // serves the REST routes; `service` registers the same class as an MCP tool
    // (the `@mcpServer` tag drives discovery, and the dispatcher resolves it with
    // constructor `@inject`). `restController` tags it for REST only, so drop
    // `service` and the MCP surface goes dark.
    this.restController(GreetingController);
    this.service(GreetingController);
    // {{agentback:registrations}}
  }
}
