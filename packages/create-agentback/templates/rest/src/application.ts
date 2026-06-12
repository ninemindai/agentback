import {RestApplication} from '@agentback/rest';
import {GreetingController} from './controllers/greeting.controller.js';

export class Application extends RestApplication {
  constructor() {
    super({});
    this.restController(GreetingController);
  }
}
