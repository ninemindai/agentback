// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The REST controller is a *caller* of the actor — actors do not automatically
// become endpoints. The cart id in the URL is the actor's stable address, and
// the `Idempotency-Key` header becomes the turn's `requestId`: replaying the
// same key returns the committed result without re-running the command.

import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, get, post, del} from '@agentback/openapi';
import {ACTOR_REGISTRY, type ActorRegistry} from '@agentback/actors';
import {AddItem, CartView, cartView, type CartState} from '../cart.actor.js';

const CartPath = z.object({id: z.string().min(1).max(64)});
const IdempotencyHeaders = z.object({
  'idempotency-key': z.string().min(1).optional(),
});

@api({basePath: '/carts'})
export class CartController {
  constructor(@inject(ACTOR_REGISTRY) private readonly carts: ActorRegistry) {}

  @post('/{id}/items', {
    path: CartPath,
    body: AddItem,
    headers: IdempotencyHeaders,
    response: CartView,
  })
  async add(input: {
    path: z.infer<typeof CartPath>;
    body: z.infer<typeof AddItem>;
    headers: z.infer<typeof IdempotencyHeaders>;
  }): Promise<z.infer<typeof CartView>> {
    const turn = await this.carts.invoke(
      'cart',
      input.path.id,
      {name: 'add', input: input.body},
      {requestId: input.headers['idempotency-key']},
    );
    return turn.output as z.infer<typeof CartView>;
  }

  @get('/{id}', {path: CartPath, response: CartView})
  async show(input: {
    path: z.infer<typeof CartPath>;
  }): Promise<z.infer<typeof CartView>> {
    const state = (await this.carts.state('cart', input.path.id)) as z.infer<
      typeof CartState
    >;
    return cartView(state);
  }

  @del('/{id}', {path: CartPath, response: CartView})
  async clear(input: {
    path: z.infer<typeof CartPath>;
  }): Promise<z.infer<typeof CartView>> {
    const turn = await this.carts.invoke('cart', input.path.id, {
      name: 'clear',
      input: {},
    });
    return turn.output as z.infer<typeof CartView>;
  }
}
