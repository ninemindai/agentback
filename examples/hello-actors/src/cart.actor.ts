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
import {AgentError, ErrorCodes} from '@agentback/openapi';
import {
  actor,
  actorCommand,
  actorQuery,
  type Actor,
  type ActorCommandContext,
} from '@agentback/actors';
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

export const Checkout = z.object({
  note: z.string().max(280).optional().describe('Optional note for the order'),
});

export const Order = z.object({
  orderId: z.string(),
  lines: z.array(
    z.object({
      sku: z.string(),
      qty: z.number().int().positive(),
      unitPrice: z.number().int().nonnegative(), // cents
      subtotal: z.number().int().nonnegative(), // cents
    }),
  ),
  total: z.number().int().nonnegative(), // cents
  note: z.string().optional(),
});

export const CartTotal = z.object({
  total: z.number().int().nonnegative(), // cents
});

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

  @actorCommand('checkout', {input: Checkout, output: Order})
  checkout(
    state: z.infer<typeof CartState>,
    input: z.infer<typeof Checkout>,
    ctx: ActorCommandContext,
  ) {
    const skus = Object.keys(state.items);
    if (skus.length === 0) {
      throw new AgentError('Cannot checkout an empty cart.', {
        code: ErrorCodes.INVALID_INPUT,
      });
    }
    const lines = skus.map(sku => {
      const qty = state.items[sku]!;
      const unitPrice = this.catalog.priceOf(sku);
      return {sku, qty, unitPrice, subtotal: unitPrice * qty};
    });
    const order: z.infer<typeof Order> = {
      orderId: ctx.requestId, // the turn's requestId doubles as the order id
      lines,
      total: lines.reduce((sum, line) => sum + line.subtotal, 0),
      note: input.note,
    };
    state.items = {}; // the order is placed; the cart is emptied
    // Emit a domain fact. An event-log runtime persists it atomically with the
    // state change and delivers it to subscribers; other runtimes ignore it.
    return {
      state,
      result: order,
      events: [
        {type: 'CheckedOut', orderId: order.orderId, total: order.total},
      ],
    };
  }

  // Read-only queries: no turn, no lease — they run concurrently with commands
  // and other reads against a state snapshot.

  @actorQuery('view', {input: z.object({}), output: CartView})
  view(state: z.infer<typeof CartState>) {
    return cartView(state);
  }

  // Unlike `checkout`, an empty cart is fine here (total 0): a query computes
  // rather than transitions.
  @actorQuery('total', {input: z.object({}), output: CartTotal})
  total(state: z.infer<typeof CartState>) {
    const total = Object.entries(state.items).reduce(
      (sum, [sku, qty]) => sum + this.catalog.priceOf(sku) * qty,
      0,
    );
    return {total};
  }
}
