import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {GreetingController} from './controllers/greeting.controller.js';

export class Application extends RestApplication {
  constructor() {
    super({});
    this.component(MCPComponent);
    this.configure('servers.MCPServer').to({
      name: '{{name}}',
      version: '0.1.0',
      transports: {stdio: false},
    });
    // One class, two surfaces — both registrations are needed. `restController`
    // serves the REST routes and binds it at `controllers.<name>`, the binding
    // the MCP dispatcher resolves with constructor `@inject`. `service` carries
    // the `@mcpServer` discovery tag the MCP server finds tools by (restController
    // tags it for REST only). Drop either and one surface goes dark.
    this.restController(GreetingController);
    this.service(GreetingController);
  }
}
