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
    this.restController(GreetingController);
    this.service(GreetingController);
  }
}
