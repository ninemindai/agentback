// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// A small typed client for the `cart` actor. Controllers (and any other caller)
// inject this instead of the raw `ACTOR_REGISTRY`, so they get typed methods —
// add(id, input) / clear(id) / view(id) — instead of the stringly-typed
// `{name, input}` command envelope. Every call still goes through
// `registry.invoke`/`registry.state`, so all the runtime guarantees hold:
// per-identity serialization, validation, rollback, and requestId idempotency.
//
// You must NOT inject the CartActor instance and call its methods directly —
// that bypasses the runtime (no serialization, no rollback, no persisted state).
// Address the actor through the registry; this client is just a typed facade.

import {z} from 'zod';
import {inject} from '@agentback/core';
import {ACTOR_REGISTRY, type ActorRegistry} from '@agentback/actors';
import {AddItem, CartView, cartView, type CartState} from './cart.actor.js';

const CART = 'cart'; // matches @actor('cart')

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
    return this.command(id, 'add', input, requestId);
  }

  /** Empty the cart. */
  clear(id: string): Promise<z.infer<typeof CartView>> {
    return this.command(id, 'clear', {});
  }

  /** Read the current cart view (no turn taken). */
  async view(id: string): Promise<z.infer<typeof CartView>> {
    const state = (await this.registry.state(CART, id)) as z.infer<
      typeof CartState
    >;
    return cartView(state);
  }

  private async command(
    id: string,
    name: string,
    input: unknown,
    requestId?: string,
  ): Promise<z.infer<typeof CartView>> {
    const turn = await this.registry.invoke(
      CART,
      id,
      {name, input},
      {requestId},
    );
    return turn.output as z.infer<typeof CartView>;
  }
}
