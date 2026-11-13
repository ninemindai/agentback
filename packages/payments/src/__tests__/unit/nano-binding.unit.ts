// Copyright Zhaohui Feng 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {
  InMemoryNanoReplayStore,
  NANO_BINDING_V1,
  NANO_MAINNET,
  NanoFacilitator,
  isValidNanoAddress,
  isValidNanoOrderId,
  nanoOrderCommitment,
  nanoRequirement,
  type NanoBlockInfo,
  type NanoRpc,
} from '../../nano.js';

const MERCHANT =
  'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const BURN =
  'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const PAYER = BURN;

const XNO = 10n ** 30n;
const PRICE = (XNO / 100n).toString(); // 0.01 XNO
const SEND = 'C'.repeat(64);
const NOW_S = 1_800_000_000;

// 128 random bits, base64url: what a client would draw for one call.
const ORDER = 'q3Rk9vX2bN7mP0aLs5Ty8w';

const BOUND = nanoRequirement({
  payTo: MERCHANT,
  amountRaw: PRICE,
  resource: '/widgets',
  requireBinding: true,
});

function block(over: {
  amount?: string;
  representative?: string;
}): NanoBlockInfo {
  return {
    confirmed: 'true',
    subtype: 'send',
    amount: over.amount ?? PRICE,
    local_timestamp: String(NOW_S - 10),
    contents: {
      type: 'state',
      account: PAYER,
      previous: 'D'.repeat(64),
      balance: (5n * XNO).toString(),
      link: '0'.repeat(64),
      link_as_account: MERCHANT,
      representative:
        over.representative ?? nanoOrderCommitment(ORDER, MERCHANT, PRICE),
    },
  };
}

function rpc(send: NanoBlockInfo): NanoRpc {
  return {
    async blockInfo(hash) {
      return hash === SEND ? send : undefined;
    },
  };
}

function facilitator(send: NanoBlockInfo): NanoFacilitator {
  return new NanoFacilitator({
    rpc: rpc(send),
    replayStore: new InMemoryNanoReplayStore(),
    now: () => NOW_S * 1000,
  });
}

function payment(payload: Record<string, unknown>): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: NANO_MAINNET,
      payload,
    }),
  ).toString('base64');
}

describe('nanoOrderCommitment', () => {
  it('matches the xno-binding v1 option C vector', () => {
    // docs/BINDING-STANDARD.md in dhyabi2/xno-call-binding: burn payTo,
    // 0.05 XNO, order id "order-0001".
    const rep = nanoOrderCommitment('order-0001', BURN, (XNO / 20n).toString());
    expect(rep).toBe(
      'nano_33q9dassq66es6mcay83n5kypqgpzjikr9bkc9ope9xch1borfphgehj4ozj',
    );
    expect(isValidNanoAddress(rep)).toBe(true);
  });

  it('changes with the order, the destination and the price', () => {
    const base = nanoOrderCommitment(ORDER, MERCHANT, PRICE);
    expect(nanoOrderCommitment(`${ORDER}x`, MERCHANT, PRICE)).not.toBe(base);
    expect(nanoOrderCommitment(ORDER, BURN, PRICE)).not.toBe(base);
    expect(nanoOrderCommitment(ORDER, MERCHANT, `${PRICE}1`)).not.toBe(base);
  });
});

describe('isValidNanoOrderId', () => {
  it('needs a URL-safe id of 22 to 128 characters', () => {
    expect(isValidNanoOrderId(ORDER)).toBe(true);
    expect(isValidNanoOrderId('order-0001')).toBe(false);
    expect(isValidNanoOrderId('a'.repeat(129))).toBe(false);
    expect(isValidNanoOrderId(`${ORDER}/`)).toBe(false);
    expect(isValidNanoOrderId(42)).toBe(false);
  });
});

describe('nanoRequirement requireBinding', () => {
  it('advertises the binding in extra', () => {
    expect(BOUND.extra).toEqual({binding: NANO_BINDING_V1});
  });

  it('leaves an unbound requirement without extra', () => {
    const plain = nanoRequirement({
      payTo: MERCHANT,
      amountRaw: PRICE,
      resource: '/widgets',
    });
    expect(plain.extra).toBeUndefined();
  });
});

describe('NanoFacilitator with a bound requirement', () => {
  it('accepts an exact send carrying the order commitment', async () => {
    const fac = facilitator(block({}));
    const pay = payment({blockHash: SEND, orderId: ORDER});
    expect(await fac.verify(pay, [BOUND])).toEqual({valid: true});
    const settled = await fac.settle(pay, [BOUND]);
    expect(settled.success).toBe(true);
    expect(settled.payload).toMatchObject({blockHash: SEND, orderId: ORDER});
  });

  it('refuses the block hash alone', async () => {
    const fac = facilitator(block({}));
    expect(await fac.verify(payment({blockHash: SEND}), [BOUND])).toEqual({
      valid: false,
      reason: 'nano: order id required',
    });
  });

  it('refuses another order id for the same block', async () => {
    const fac = facilitator(block({}));
    const pay = payment({blockHash: SEND, orderId: `${ORDER}Z`});
    expect(await fac.verify(pay, [BOUND])).toEqual({
      valid: false,
      reason: 'nano: not bound to this order',
    });
  });

  it('refuses a send whose representative is not the commitment', async () => {
    const fac = facilitator(block({representative: MERCHANT}));
    const pay = payment({blockHash: SEND, orderId: ORDER});
    expect(await fac.verify(pay, [BOUND])).toEqual({
      valid: false,
      reason: 'nano: not bound to this order',
    });
  });

  it('refuses an overpayment, since the commitment covers the price', async () => {
    const over = (BigInt(PRICE) + 1n).toString();
    const fac = facilitator(block({amount: over}));
    const pay = payment({blockHash: SEND, orderId: ORDER});
    expect(await fac.verify(pay, [BOUND])).toEqual({
      valid: false,
      reason: 'nano: amount not exact',
    });
  });

  it('refuses a malformed order id', async () => {
    const fac = facilitator(block({}));
    const pay = payment({blockHash: SEND, orderId: 'short'});
    expect(await fac.verify(pay, [BOUND])).toEqual({
      valid: false,
      reason: 'nano: malformed order id',
    });
  });

  it('pays once per block even with the right order id', async () => {
    const fac = facilitator(block({}));
    const pay = payment({blockHash: SEND, orderId: ORDER});
    expect((await fac.settle(pay, [BOUND])).success).toBe(true);
    expect((await fac.settle(pay, [BOUND])).success).toBe(false);
  });
});
