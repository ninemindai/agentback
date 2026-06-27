// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {RestApplication} from '@agentback/rest';
import {EventSourcedActorsComponent} from '@agentback/actors';
import {Catalog} from './catalog.js';
import {CartActor} from './cart.actor.js';
import {CartController} from './controllers/cart.controller.js';

/**
 * hello-actors application: a shopping cart exposed over REST, where each
 * `cart/<id>` is an independently-addressable, serialized actor.
 *
 * `EventSourcedActorsComponent` binds `ACTOR_RUNTIME` (the event-logging
 * single-process adapter) plus the `ActorRegistry`. It is a superset of the
 * plain in-memory adapter: same serialized turns + idempotency, and it also
 * persists each command's `events` to a per-identity log you can read
 * (`registry.events`) or subscribe to (`registry.subscribe`). The README shows
 * swapping in `RedisActorsComponent` for cross-process serialization.
 */
export class HelloActorsApplication extends RestApplication {
  constructor() {
    super();

    // ACTOR_RUNTIME (event-logging, in-memory) + ACTOR_REGISTRY.
    this.component(EventSourcedActorsComponent);

    // A plain DI service the actor injects — proves the registry resolves each
    // actor through its own binding (constructor @inject is honored).
    this.service(Catalog);

    // The @actor service. `service()` keeps its actor extension membership so
    // the registry finds it at start(). The controller reaches it with
    // `@injectActor(CartActor)` — no client class needed.
    this.service(CartActor);
    this.restController(CartController);
  }
}
