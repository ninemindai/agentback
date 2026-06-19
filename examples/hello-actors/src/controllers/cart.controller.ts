// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The REST controller is a *caller* of the actor — actors do not automatically
// become endpoints. It injects a typed `Carts` client (not the raw registry),
// so the handlers read as plain method calls; the client routes each one through
// the runtime. The cart id in the URL is the actor's stable address, and the
// `Idempotency-Key` header becomes the turn's `requestId`: replaying the same
// key returns the committed result without re-running the command.

import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, get, post, del} from '@agentback/openapi';
import {AddItem, CartView, Checkout, Order} from '../cart.actor.js';
import {Carts} from '../carts.js';

const CartPath = z.object({id: z.string().min(1).max(64)});
const IdempotencyHeaders = z.object({
  'idempotency-key': z.string().min(1).optional(),
});

@api({basePath: '/carts'})
export class CartController {
  constructor(@inject('services.Carts') private readonly carts: Carts) {}

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
    return this.carts.add(
      input.path.id,
      input.body,
      input.headers['idempotency-key'],
    );
  }

  @get('/{id}', {path: CartPath, response: CartView})
  async show(input: {
    path: z.infer<typeof CartPath>;
  }): Promise<z.infer<typeof CartView>> {
    return this.carts.view(input.path.id);
  }

  @del('/{id}', {path: CartPath, response: CartView})
  async clear(input: {
    path: z.infer<typeof CartPath>;
  }): Promise<z.infer<typeof CartView>> {
    return this.carts.clear(input.path.id);
  }

  @post('/{id}/checkout', {
    path: CartPath,
    body: Checkout,
    headers: IdempotencyHeaders,
    response: Order,
  })
  async checkout(input: {
    path: z.infer<typeof CartPath>;
    body: z.infer<typeof Checkout>;
    headers: z.infer<typeof IdempotencyHeaders>;
  }): Promise<z.infer<typeof Order>> {
    return this.carts.checkout(
      input.path.id,
      input.body,
      input.headers['idempotency-key'],
    );
  }
}
