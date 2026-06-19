// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// A small typed client for the `cart` actor. Controllers (and any other caller)
// inject this instead of the raw `ACTOR_REGISTRY`. Internally it uses the
// registry's typed proxy — `registry.ref(CartActor, id)` — whose methods mirror
// the `@actorCommand` methods, so `add`/`clear` are fully typed and still route
// through the runtime (per-identity serialization, validation, rollback,
// requestId idempotency). `view` adds a state read the proxy doesn't cover.
//
// You must NOT inject the CartActor instance and call its methods directly —
// that bypasses the runtime (no serialization, no rollback, no persisted state).
// Address the actor through the registry; this client is just a typed facade.

import {z} from 'zod';
import {inject} from '@agentback/core';
import {ACTOR_REGISTRY, type ActorRegistry} from '@agentback/actors';
import {
  AddItem,
  CartActor,
  CartView,
  cartView,
  type CartState,
} from './cart.actor.js';

export class Carts {
  constructor(
    @inject(ACTOR_REGISTRY) private readonly registry: ActorRegistry,
  ) {}

  /** Add an item. Pass `requestId` (e.g. an Idempotency-Key) to make it a safe retry. */
  add(
    id: string,
    input: z.infer<typeof AddItem>,
    requestId?: string,
  ): Promise<z.infer<typeof CartView>> {
    return this.registry.ref(CartActor, id).add(input, {requestId});
  }

  /** Empty the cart. */
  clear(id: string): Promise<z.infer<typeof CartView>> {
    return this.registry.ref(CartActor, id).clear({});
  }

  /** Read the current cart view (no turn taken). */
  async view(id: string): Promise<z.infer<typeof CartView>> {
    const state = (await this.registry.state('cart', id)) as z.infer<
      typeof CartState
    >;
    return cartView(state);
  }
}
