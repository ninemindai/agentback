// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {MppRail, InMemoryMppSessionStore} from '../../mpp.js';
import type {PaymentContext} from '../../types.js';

const ctx = (sessionId?: string): PaymentContext => ({
  method: 'POST',
  resource: '/widgets',
  sessionId,
});

/** A rail charging one unit per call, over the given store. */
function rail(store: InMemoryMppSessionStore, now = () => 1_000) {
  return new MppRail({store, cost: () => 1, now});
}

describe('MppRail.authorize', () => {
  it('challenges (no_session) when no session is presented', async () => {
    const result = await rail(new InMemoryMppSessionStore()).authorize(ctx());
    expect(result.status).toBe('payment_required');
    if (result.status !== 'payment_required') throw new Error('unreachable');
    if (result.challenge.rail !== 'mpp') throw new Error('unreachable');
    expect(result.challenge.reason).toBe('no_session');
  });

  it('challenges (no_session) when the session is unknown', async () => {
    const result = await rail(new InMemoryMppSessionStore()).authorize(
      ctx('ghost'),
    );
    expect(result.status).toBe('payment_required');
    if (result.status !== 'payment_required') throw new Error('unreachable');
    if (result.challenge.rail !== 'mpp') throw new Error('unreachable');
    expect(result.challenge.reason).toBe('no_session');
  });

  it('streams against a budgeted session and returns remaining', async () => {
    const store = new InMemoryMppSessionStore();
    store.open({id: 's1', limit: 2, spent: 0});
    const result = await rail(store).authorize(ctx('s1'));
    expect(result.status).toBe('paid');
    if (result.status !== 'paid') throw new Error('unreachable');
    expect(result.receipt).toMatchObject({rail: 'mpp', success: true});
    expect(result.receipt.payload).toMatchObject({
      sessionId: 's1',
      remaining: 1,
    });
    expect(store.get('s1')?.spent).toBe(1);
  });

  it('exhausts after the budget is spent', async () => {
    const store = new InMemoryMppSessionStore();
    store.open({id: 's1', limit: 2, spent: 0});
    const r = rail(store);
    await r.authorize(ctx('s1')); // spent 1
    await r.authorize(ctx('s1')); // spent 2
    const third = await r.authorize(ctx('s1')); // over budget
    expect(third.status).toBe('payment_required');
    if (third.status !== 'payment_required') throw new Error('unreachable');
    if (third.challenge.rail !== 'mpp') throw new Error('unreachable');
    expect(third.challenge.reason).toBe('exhausted');
    expect(store.get('s1')?.spent).toBe(2); // not over-charged
  });

  it('challenges (expired) past the session expiry', async () => {
    const store = new InMemoryMppSessionStore();
    store.open({id: 's1', limit: 10, spent: 0, expiresAt: 500});
    const result = await rail(store, () => 1_000).authorize(ctx('s1'));
    expect(result.status).toBe('payment_required');
    if (result.status !== 'payment_required') throw new Error('unreachable');
    if (result.challenge.rail !== 'mpp') throw new Error('unreachable');
    expect(result.challenge.reason).toBe('expired');
  });
});
