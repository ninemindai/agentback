// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {X402Rail, paymentMiddleware} from '../../x402.js';
import type {
  PaymentContext,
  PaymentRequirements,
  X402Facilitator,
  X402SettleResult,
  X402VerifyResult,
} from '../../types.js';

const REQS: PaymentRequirements[] = [
  {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '1000',
    asset: '0xUSDC',
    payTo: '0xMerchant',
    resource: '/widgets',
  },
];

function facilitator(
  verify: X402VerifyResult,
  settle: X402SettleResult = {success: true, payload: {txHash: '0xabc'}},
): X402Facilitator {
  return {
    verify: async () => verify,
    settle: async () => settle,
  };
}

const ctx = (paymentHeader?: string): PaymentContext => ({
  method: 'POST',
  resource: '/widgets',
  paymentHeader,
});

function rail(fac: X402Facilitator) {
  return new X402Rail({facilitator: fac, requirements: () => REQS});
}

describe('X402Rail.authorize', () => {
  it('challenges with 402 requirements when no payment is presented', async () => {
    const result = await rail(facilitator({valid: true})).authorize(ctx());
    expect(result.status).toBe('payment_required');
    if (result.status !== 'payment_required') throw new Error('unreachable');
    if (result.challenge.rail !== 'x402') throw new Error('unreachable');
    expect(result.challenge.x402Version).toBe(1);
    expect(result.challenge.accepts).toEqual(REQS);
    expect(result.challenge.error).toBeUndefined();
  });

  it('settles and returns a receipt when the payment verifies', async () => {
    const result = await rail(facilitator({valid: true})).authorize(
      ctx('PAYMENT-BLOB'),
    );
    expect(result.status).toBe('paid');
    if (result.status !== 'paid') throw new Error('unreachable');
    expect(result.receipt).toMatchObject({rail: 'x402', success: true});
    expect(result.receipt.payload).toEqual({txHash: '0xabc'});
  });

  it('challenges with an error when verification fails', async () => {
    const result = await rail(
      facilitator({valid: false, reason: 'expired'}),
    ).authorize(ctx('BAD'));
    expect(result.status).toBe('payment_required');
    if (result.status !== 'payment_required') throw new Error('unreachable');
    expect(result.challenge.error).toBe('expired');
  });

  it('challenges when settlement fails after a valid verify', async () => {
    const result = await rail(
      facilitator({valid: true}, {success: false}),
    ).authorize(ctx('GOOD-BUT-UNSETTLED'));
    expect(result.status).toBe('payment_required');
    if (result.status !== 'payment_required') throw new Error('unreachable');
    expect(result.challenge.error).toMatch(/settle/i);
  });
});

// Minimal Express req/res/next doubles.
function fakeReq(paymentHeader?: string) {
  return {
    method: 'POST',
    originalUrl: '/widgets',
    header: (name: string) =>
      name.toLowerCase() === 'x-payment' ? paymentHeader : undefined,
  };
}
function fakeRes() {
  const res: {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
    status(code: number): typeof res;
    json(b: unknown): typeof res;
    setHeader(k: string, v: string): void;
  } = {
    headers: {},
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(b) {
      res.body = b;
      return res;
    },
    setHeader(k, v) {
      res.headers[k.toLowerCase()] = v;
    },
  };
  return res;
}

describe('paymentMiddleware', () => {
  it('responds 402 with the challenge and does not call next', async () => {
    const mw = paymentMiddleware(rail(facilitator({valid: true})));
    const res = fakeRes();
    let nextCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mw(fakeReq() as any, res as any, () => (nextCalled = true));
    await new Promise(r => setImmediate(r));
    expect(res.statusCode).toBe(402);
    expect((res.body as {accepts: unknown[]}).accepts).toEqual(REQS);
    expect(nextCalled).toBe(false);
  });

  it('calls next and sets X-PAYMENT-RESPONSE when paid', async () => {
    const mw = paymentMiddleware(rail(facilitator({valid: true})));
    const res = fakeRes();
    let nextCalled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await mw(fakeReq('PAYMENT') as any, res as any, () => (nextCalled = true));
    await new Promise(r => setImmediate(r));
    expect(nextCalled).toBe(true);
    expect(res.headers['x-payment-response']).toBeDefined();
  });
});
