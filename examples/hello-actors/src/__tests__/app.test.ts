// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Proves the four actor properties end-to-end over HTTP:
//   addressing, per-identity serialization, request idempotency, and that a
//   domain error from inside a turn surfaces as a client-fixable 400.

import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {HelloActorsApplication} from '../application.js';

describe('hello-actors', () => {
  it('addressing: each cart id is independent state', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    await t.http.post('/carts/ada/items').send({sku: 'keyboard'}).expect(200);
    await t.http
      .post('/carts/grace/items')
      .send({sku: 'mouse', qty: 2})
      .expect(200);

    const ada = await t.http.get('/carts/ada').expect(200);
    const grace = await t.http.get('/carts/grace').expect(200);
    expect(ada.body).toEqual({items: {keyboard: 1}, itemCount: 1});
    expect(grace.body).toEqual({items: {mouse: 2}, itemCount: 2});
  });

  it('serialized turns: concurrent adds to one cart never lose an update', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    // Fire 20 overlapping adds at the same cart. Without per-identity
    // serialization these would read-modify-write over each other and lose
    // updates; the runtime serializes them, so every increment lands.
    await Promise.all(
      Array.from({length: 20}, () =>
        t.http.post('/carts/ada/items').send({sku: 'keyboard'}).expect(200),
      ),
    );

    const res = await t.http.get('/carts/ada').expect(200);
    expect(res.body.itemCount).toBe(20);
  });

  it('idempotency: replaying an Idempotency-Key does not double-add', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    const send = () =>
      t.http
        .post('/carts/ada/items')
        .set('Idempotency-Key', 'add-keyboard-once')
        .send({sku: 'keyboard'})
        .expect(200);

    const first = await send();
    const replay = await send();
    expect(first.body).toEqual({items: {keyboard: 1}, itemCount: 1});
    expect(replay.body).toEqual(first.body); // committed result replayed, no re-run
  });

  it('domain error: an unknown SKU is a 400 the client can fix', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    const res = await t.http
      .post('/carts/ada/items')
      .send({sku: 'banana'})
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/Unknown SKU/);
  });

  it('clear: DELETE resets the cart', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    await t.http.post('/carts/ada/items').send({sku: 'keyboard'}).expect(200);
    await t.http.delete('/carts/ada').expect(200);

    const res = await t.http.get('/carts/ada').expect(200);
    expect(res.body).toEqual({items: {}, itemCount: 0});
  });

  it('checkout: prices the cart into an order and empties it', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    await t.http.post('/carts/ada/items').send({sku: 'keyboard'}).expect(200);
    await t.http
      .post('/carts/ada/items')
      .send({sku: 'mouse', qty: 2})
      .expect(200);

    const res = await t.http
      .post('/carts/ada/checkout')
      .set('Idempotency-Key', 'order-1')
      .send({note: 'gift wrap'})
      .expect(200);

    expect(res.body.orderId).toBe('order-1');
    expect(res.body.total).toBe(4999 + 2999 * 2); // keyboard + 2x mouse, cents
    expect(res.body.note).toBe('gift wrap');
    expect(res.body.lines).toHaveLength(2);

    // The order is placed; the cart is emptied.
    const cart = await t.http.get('/carts/ada').expect(200);
    expect(cart.body).toEqual({items: {}, itemCount: 0});
  });

  it('checkout: an empty cart is a 400', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    const res = await t.http.post('/carts/ada/checkout').send({}).expect(400);
    expect(JSON.stringify(res.body)).toMatch(/empty cart/i);
  });

  it('checkout: replaying the Idempotency-Key returns the same order, once', async () => {
    await using t = await createTestApp(HelloActorsApplication);

    await t.http.post('/carts/ada/items').send({sku: 'keyboard'}).expect(200);
    const first = await t.http
      .post('/carts/ada/checkout')
      .set('Idempotency-Key', 'order-9')
      .send({})
      .expect(200);
    const replay = await t.http
      .post('/carts/ada/checkout')
      .set('Idempotency-Key', 'order-9')
      .send({})
      .expect(200);

    expect(replay.body).toEqual(first.body); // committed result replayed
    const cart = await t.http.get('/carts/ada').expect(200);
    expect(cart.body.itemCount).toBe(0);
  });
});
