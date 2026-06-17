// {{agentback:imports}}
import {RestApplication} from '@agentback/rest';
import {GreetingController} from './controllers/greeting.controller.js';

export class Application extends RestApplication {
  constructor() {
    super({/* {{agentback:rest-config}} */});
    // {{agentback:components}}
    this.restController(GreetingController);
    // {{agentback:registrations}}
  }
}
