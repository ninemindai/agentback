// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The REST controller is a *caller* of the actor — actors do not automatically
// become endpoints. It injects a typed actor accessor with `@injectActor`, so
// there is no hand-written client class: `this.carts(id)` is the typed proxy for
// `cart/<id>`, and its methods mirror the `@actorCommand` / `@actorQuery`
// methods. The cart id in the URL is the actor's stable address; the
// `Idempotency-Key` header becomes the turn's `requestId`.

import {z} from 'zod';
import {api, get, post, del} from '@agentback/openapi';
import {injectActor, type ActorAccessor} from '@agentback/actors';
import {
  AddItem,
  CartActor,
  CartTotal,
  CartView,
  Checkout,
  Order,
} from '../cart.actor.js';

const CartPath = z.object({id: z.string().min(1).max(64)});
const IdempotencyHeaders = z.object({
  'idempotency-key': z.string().min(1).optional(),
});

@api({basePath: '/carts'})
export class CartController {
  constructor(
    @injectActor(CartActor) private readonly carts: ActorAccessor<CartActor>,
  ) {}

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
    return this.carts(input.path.id).add(input.body, {
      requestId: input.headers['idempotency-key'],
    });
  }

  @get('/{id}', {path: CartPath, response: CartView})
  async show(input: {
    path: z.infer<typeof CartPath>;
  }): Promise<z.infer<typeof CartView>> {
    return this.carts(input.path.id).view({});
  }

  @get('/{id}/total', {path: CartPath, response: CartTotal})
  async total(input: {
    path: z.infer<typeof CartPath>;
  }): Promise<z.infer<typeof CartTotal>> {
    return this.carts(input.path.id).total({});
  }

  @del('/{id}', {path: CartPath, response: CartView})
  async clear(input: {
    path: z.infer<typeof CartPath>;
  }): Promise<z.infer<typeof CartView>> {
    return this.carts(input.path.id).clear({});
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
    return this.carts(input.path.id).checkout(input.body, {
      requestId: input.headers['idempotency-key'],
    });
  }
}
