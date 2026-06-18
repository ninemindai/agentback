// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {RestApplication} from '@agentback/rest';
import {InMemoryActorsComponent} from '@agentback/actors';
import {Catalog} from './catalog.js';
import {CartActor} from './cart.actor.js';
import {CartController} from './controllers/cart.controller.js';

/**
 * hello-actors application: a shopping cart exposed over REST, where each
 * `cart/<id>` is an independently-addressable, serialized actor.
 *
 * `InMemoryActorsComponent` binds `ACTOR_RUNTIME` (the single-process reference
 * adapter) plus the `ActorRegistry`, which at `start()` discovers every `@actor`
 * service and compiles its `@actorCommand` methods into the runtime's
 * transport-neutral port. The README shows swapping in `RedisActorsComponent`
 * for cross-process serialization — the actor and controller don't change.
 */
export class HelloActorsApplication extends RestApplication {
  constructor() {
    super();

    // ACTOR_RUNTIME (in-memory) + ACTOR_REGISTRY.
    this.component(InMemoryActorsComponent);

    // A plain DI service the actor injects — proves the registry resolves each
    // actor through its own binding (constructor @inject is honored).
    this.service(Catalog);

    // The @actor service. `service()` keeps its actor extension membership so
    // the registry finds it at start(); the controller is just a caller.
    this.service(CartActor);
    this.restController(CartController);
  }
}
