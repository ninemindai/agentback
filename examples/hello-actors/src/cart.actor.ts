// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// One actor = a DI service implementing a typed state machine with a stable
// address (`cart/<id>`). State is an explicit argument and return value, never
// an instance field, so instance lifetime does not affect persistence or
// rollback. The runtime serializes turns per cart id and commits state only
// after both state and result pass Zod validation.

import {z} from 'zod';
import {inject} from '@agentback/core';
import {actor, actorCommand, type Actor} from '@agentback/actors';
import {Catalog} from './catalog.js';

export const CartState = z.object({
  items: z.record(z.string(), z.number().int().positive()),
});

export const AddItem = z.object({
  sku: z.string().min(1).describe('Catalog SKU, e.g. "keyboard"'),
  qty: z.number().int().positive().max(99).default(1),
});

// One result schema, used by both commands AND the GET read — "one artifact,
// many views". `items` is the raw state; `itemCount` is derived.
export const CartView = z.object({
  items: z.record(z.string(), z.number().int().nonnegative()),
  itemCount: z.number().int().nonnegative(),
});

export function cartView(
  state: z.infer<typeof CartState>,
): z.infer<typeof CartView> {
  const items = {...state.items};
  const itemCount = Object.values(items).reduce((sum, qty) => sum + qty, 0);
  return {items, itemCount};
}

@actor('cart', {state: CartState})
export class CartActor implements Actor<z.infer<typeof CartState>> {
  constructor(@inject('services.Catalog') private readonly catalog: Catalog) {}

  initialState(): z.infer<typeof CartState> {
    return {items: {}};
  }

  @actorCommand('add', {input: AddItem, output: CartView})
  add(state: z.infer<typeof CartState>, input: z.infer<typeof AddItem>) {
    this.catalog.assertExists(input.sku); // AgentError (→ 400) on unknown SKU
    state.items[input.sku] = (state.items[input.sku] ?? 0) + input.qty;
    return {state, result: cartView(state)};
  }

  @actorCommand('clear', {input: z.object({}), output: CartView})
  clear(state: z.infer<typeof CartState>) {
    state.items = {};
    return {state, result: cartView(state)};
  }
}
