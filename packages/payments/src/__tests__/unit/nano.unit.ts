// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {
  DEFAULT_NANO_MAX_TIMEOUT_SECONDS,
  FetchNanoRpc,
  InMemoryNanoReplayStore,
  NANO_MAINNET,
  NanoFacilitator,
  NanoRpcUnavailableError,
  isValidNanoAddress,
  nanoRequirement,
  type NanoBlockInfo,
  type NanoFacilitatorOptions,
  type NanoRpc,
} from '../../nano.js';
import {X402Rail} from '../../x402.js';
import type {
  PaymentContext,
  PaymentRequirements,
  X402Facilitator,
} from '../../types.js';

// Real mainnet accounts (genesis, and the all-zero burn account), so the
// checksums are independently known-good.
const MERCHANT =
  'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const OTHER =
  'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const PAYER = OTHER;

const XNO = 10n ** 30n;
const PRICE = (XNO / 100n).toString(); // 0.01 XNO

const SEND = 'A'.repeat(64);
const PREV = 'B'.repeat(64);

// A fixed clock; blocks default to being seen 10s before it.
const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1000;

const USDC: PaymentRequirements = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '10000',
  asset: '0xUSDC',
  payTo: '0xMerchant',
  resource: '/widgets',
};
const NANO = nanoRequirement({
  payTo: MERCHANT,
  amountRaw: PRICE,
  resource: '/widgets',
});
const ACCEPTS = [USDC, NANO];

function block(over: {
  confirmed?: string;
  subtype?: string;
  balance?: string;
  amount?: string;
  localTimestamp?: string | null;
  dest?: string;
}): NanoBlockInfo {
  const balance = over.balance ?? (5n * XNO - BigInt(PRICE)).toString();
  return {
    confirmed: over.confirmed ?? 'true',
    subtype: over.subtype ?? 'send',
    amount: over.amount ?? (5n * XNO - BigInt(balance)).toString(),
    ...(over.localTimestamp === null
      ? {}
      : {local_timestamp: over.localTimestamp ?? String(NOW_S - 10)}),
    contents: {
      type: 'state',
      account: PAYER,
      previous: PREV,
      balance,
      link: '0'.repeat(64),
      link_as_account: over.dest ?? MERCHANT,
    },
  };
}

const PREVIOUS: NanoBlockInfo = {
  confirmed: 'true',
  subtype: 'receive',
  contents: {
    type: 'state',
    account: PAYER,
    previous: '0'.repeat(64),
    balance: (5n * XNO).toString(),
    link: '0'.repeat(64),
  },
};

function rpc(
  send: NanoBlockInfo | Error,
  previous: NanoBlockInfo = PREVIOUS,
): NanoRpc & {calls: string[]} {
  const calls: string[] = [];
  return {
    calls,
    async blockInfo(hash) {
      calls.push(hash);
      if (send instanceof Error) throw send;
      if (hash === SEND) return send;
      if (hash === PREV) return previous;
      return undefined;
    },
  };
}

function nanoFacilitator(
  opts: Partial<NanoFacilitatorOptions> = {},
): NanoFacilitator {
  return new NanoFacilitator({
    replayStore: new InMemoryNanoReplayStore(),
    now: () => NOW_MS,
    ...opts,
  });
}

function nanoPayment(blockHash: unknown): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: NANO_MAINNET,
      payload: {blockHash},
    }),
  ).toString('base64');
}

// Stands in for the existing USDC facilitator: it knows one blob.
const USDC_PAYMENT = 'USDC-PAYMENT-BLOB';
function usdcFacilitator(): X402Facilitator & {seen: string[]} {
  const seen: string[] = [];
  return {
    seen,
    verify: async payment => {
      seen.push(payment);
      return payment === USDC_PAYMENT
        ? {valid: true}
        : {valid: false, reason: 'invalid payment authorization'};
    },
    settle: async () => ({
      success: true,
      payload: {txHash: '0xabc', network: 'base'},
    }),
  };
}

const ctx = (paymentHeader?: string): PaymentContext => ({
  method: 'POST',
  resource: '/widgets',
  paymentHeader,
});

describe('NanoFacilitator.verify', () => {
  it('accepts a confirmed send of the price to payTo', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({}))});
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: true,
    });
  });

  it('accepts an overpayment and a lowercase hash', async () => {
    const balance = (4n * XNO).toString();
    const fac = nanoFacilitator({rpc: rpc(block({balance}))});
    const result = await fac.verify(nanoPayment(SEND.toLowerCase()), ACCEPTS);
    expect(result.valid).toBe(true);
  });

  it('rejects an underpayment', async () => {
    const balance = (5n * XNO - BigInt(PRICE) + 1n).toString();
    const fac = nanoFacilitator({rpc: rpc(block({balance}))});
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: amount too low',
    });
  });

  it('rejects an unconfirmed block', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({confirmed: 'false'}))});
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: not confirmed',
    });
  });

  it('rejects a send to another account', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({dest: OTHER}))});
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: wrong destination',
    });
  });

  it('rejects a receive block', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({subtype: 'receive'}))});
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: not a send block',
    });
  });

  it('rejects a malformed block hash without calling the node', async () => {
    const node = rpc(block({}));
    const fac = nanoFacilitator({rpc: node});
    for (const bad of ['xyz', 'A'.repeat(63), 'G'.repeat(64), 42]) {
      expect(await fac.verify(nanoPayment(bad), ACCEPTS)).toEqual({
        valid: false,
        reason: 'nano: malformed block hash',
      });
    }
    expect(node.calls).toEqual([]);
  });

  it('rejects a payTo with a bad checksum', async () => {
    const badPayTo = MERCHANT.slice(0, -1) + '4';
    const fac = nanoFacilitator({rpc: rpc(block({dest: badPayTo}))});
    const reqs = [{...NANO, payTo: badPayTo}];
    expect(await fac.verify(nanoPayment(SEND), reqs)).toEqual({
      valid: false,
      reason: 'nano: invalid payTo address',
    });
  });

  it('rejects a block the node does not know', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({}))});
    expect(await fac.verify(nanoPayment('C'.repeat(64)), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: block not found',
    });
  });

  it('rejects a send older than maxTimeoutSeconds', async () => {
    const old = String(NOW_S - DEFAULT_NANO_MAX_TIMEOUT_SECONDS - 1);
    const fac = nanoFacilitator({rpc: rpc(block({localTimestamp: old}))});
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: block too old',
    });
    // The window is the requirement's own maxTimeoutSeconds.
    const wide = [{...NANO, maxTimeoutSeconds: 3600}];
    expect((await fac.verify(nanoPayment(SEND), wide)).valid).toBe(true);
    const tight = [{...NANO, maxTimeoutSeconds: 5}];
    expect(
      await nanoFacilitator({rpc: rpc(block({}))}).verify(
        nanoPayment(SEND),
        tight,
      ),
    ).toEqual({valid: false, reason: 'nano: block too old'});
  });

  it('accepts a send at the edge of the window', async () => {
    const edge = String(NOW_S - DEFAULT_NANO_MAX_TIMEOUT_SECONDS);
    const fac = nanoFacilitator({rpc: rpc(block({localTimestamp: edge}))});
    expect((await fac.verify(nanoPayment(SEND), ACCEPTS)).valid).toBe(true);
  });

  it('fails closed when the block time is missing, zero, or ahead', async () => {
    for (const localTimestamp of [null, '0', 'soon', String(NOW_S + 3600)]) {
      const fac = nanoFacilitator({rpc: rpc(block({localTimestamp}))});
      expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
        valid: false,
        reason: 'nano: block time unknown',
      });
    }
  });

  it('throws a generic error, not an invalid payment, when the node is down', async () => {
    const fac = nanoFacilitator({
      rpc: rpc(new Error('connect ECONNREFUSED 10.0.0.7:7076')),
    });
    const err = await fac.verify(nanoPayment(SEND), ACCEPTS).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NanoRpcUnavailableError);
    expect((err as Error).message).toBe('nano: node unavailable');
    expect((err as Error).message).not.toMatch(/ECONNREFUSED|10\.0\.0\.7/);
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it('reads the amount from block_info, not from the previous block', async () => {
    // Balance arithmetic would say 1 raw was sent; the node says PRICE was.
    const balance = (5n * XNO - 1n).toString();
    const node = rpc(block({balance, amount: PRICE}));
    const fac = nanoFacilitator({rpc: node});
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: true,
    });
    expect(node.calls).toEqual([SEND]);

    const short = (BigInt(PRICE) - 1n).toString();
    const fac2 = nanoFacilitator({rpc: rpc(block({amount: short}))});
    expect(await fac2.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: amount too low',
    });
  });

  it('accepts a send whose previous block is a legacy block', async () => {
    const legacyPrevious = {
      confirmed: 'true',
      contents: {type: 'receive', previous: '0'.repeat(64), source: PREV},
    } as unknown as NanoBlockInfo;
    const node = rpc(block({}), legacyPrevious);
    const fac = nanoFacilitator({rpc: node});
    const settled = await fac.settle(nanoPayment(SEND), ACCEPTS);
    expect(settled).toMatchObject({success: true, payload: {amount: PRICE}});
    expect(node.calls).not.toContain(PREV);
  });

  it('rejects a send with no readable amount', async () => {
    for (const amount of ['0', '-5', 'lots']) {
      const fac = nanoFacilitator({rpc: rpc(block({amount}))});
      expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
        valid: false,
        reason: 'nano: unreadable amount',
      });
    }
  });

  it('rejects a Nano payment when no Nano requirement is offered', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({}))});
    const result = await fac.verify(nanoPayment(SEND), [USDC]);
    expect(result).toEqual({
      valid: false,
      reason: 'nano: not an accepted network',
    });
  });

  it('reads a plain-JSON payload as well as base64', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({}))});
    const json = JSON.stringify({
      network: NANO_MAINNET,
      payload: {blockHash: SEND},
    });
    expect((await fac.verify(json, ACCEPTS)).valid).toBe(true);
  });
});

describe('NanoFacilitator.settle', () => {
  it('records the block so it pays once', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({}))});
    const first = await fac.settle(nanoPayment(SEND), ACCEPTS);
    expect(first).toEqual({
      success: true,
      payload: {
        network: NANO_MAINNET,
        blockHash: SEND,
        payer: PAYER,
        payTo: MERCHANT,
        amount: PRICE,
      },
    });
    expect(await fac.settle(nanoPayment(SEND), ACCEPTS)).toEqual({
      success: false,
    });
    expect(await fac.verify(nanoPayment(SEND), ACCEPTS)).toEqual({
      valid: false,
      reason: 'nano: block already used',
    });
  });

  it('throws on a node outage and records nothing', async () => {
    const store = new InMemoryNanoReplayStore();
    const fac = nanoFacilitator({
      rpc: rpc(new Error('timeout')),
      replayStore: store,
    });
    await expect(fac.settle(nanoPayment(SEND), ACCEPTS)).rejects.toThrow(
      NanoRpcUnavailableError,
    );
    expect(store.has(SEND)).toBe(false);
  });

  it('requires a replay store', () => {
    expect(
      () => new NanoFacilitator({} as unknown as NanoFacilitatorOptions),
    ).toThrow(/replayStore is required/);
  });

  it('re-verifies before recording', async () => {
    const store = new InMemoryNanoReplayStore();
    const fac = nanoFacilitator({
      rpc: rpc(block({confirmed: 'false'})),
      replayStore: store,
    });
    expect(await fac.settle(nanoPayment(SEND), ACCEPTS)).toEqual({
      success: false,
    });
    expect(store.has(SEND)).toBe(false);
  });
});

describe('NanoFacilitator fallback', () => {
  it('delegates non-Nano payments unchanged', async () => {
    const usdc = usdcFacilitator();
    const node = rpc(block({}));
    const fac = nanoFacilitator({fallback: usdc, rpc: node});
    expect(await fac.verify(USDC_PAYMENT, ACCEPTS)).toEqual({valid: true});
    expect(await fac.settle(USDC_PAYMENT, ACCEPTS)).toEqual({
      success: true,
      payload: {txHash: '0xabc', network: 'base'},
    });
    expect(usdc.seen).toEqual([USDC_PAYMENT]);
    expect(node.calls).toEqual([]);
  });

  it('rejects non-Nano payments when there is no fallback', async () => {
    const fac = nanoFacilitator({rpc: rpc(block({}))});
    expect(await fac.verify(USDC_PAYMENT, ACCEPTS)).toEqual({
      valid: false,
      reason: 'unsupported payment',
    });
    expect(await fac.settle(USDC_PAYMENT, ACCEPTS)).toEqual({success: false});
  });
});

describe('X402Rail with USDC and Nano accepts', () => {
  const rail = (facilitator: X402Facilitator) =>
    new X402Rail({facilitator, requirements: () => ACCEPTS});

  it('without NanoFacilitator, a Nano payment is challenged', async () => {
    const result = await rail(usdcFacilitator()).authorize(
      ctx(nanoPayment(SEND)),
    );
    expect(result.status).toBe('payment_required');
  });

  it('with NanoFacilitator, a Nano payment is paid', async () => {
    const fac = nanoFacilitator({
      fallback: usdcFacilitator(),
      rpc: rpc(block({})),
    });
    const result = await rail(fac).authorize(ctx(nanoPayment(SEND)));
    expect(result.status).toBe('paid');
    if (result.status !== 'paid') throw new Error('unreachable');
    expect(result.receipt).toMatchObject({rail: 'x402', success: true});
    expect(result.receipt.payload).toMatchObject({blockHash: SEND});

    const again = await rail(fac).authorize(ctx(nanoPayment(SEND)));
    expect(again.status).toBe('payment_required');
  });

  it('a node outage fails the call without a 402 that leaks the cause', async () => {
    const fac = nanoFacilitator({
      fallback: usdcFacilitator(),
      rpc: rpc(new Error('upstream secret detail')),
    });
    await expect(rail(fac).authorize(ctx(nanoPayment(SEND)))).rejects.toThrow(
      'nano: node unavailable',
    );
  });

  it('with NanoFacilitator, USDC is still paid via the fallback', async () => {
    const fac = nanoFacilitator({
      fallback: usdcFacilitator(),
      rpc: rpc(block({})),
    });
    const result = await rail(fac).authorize(ctx(USDC_PAYMENT));
    expect(result.status).toBe('paid');
    if (result.status !== 'paid') throw new Error('unreachable');
    expect(result.receipt.payload).toEqual({txHash: '0xabc', network: 'base'});
  });

  it('challenges with both requirements when nothing is presented', async () => {
    const fac = nanoFacilitator({fallback: usdcFacilitator()});
    const result = await rail(fac).authorize(ctx());
    if (result.status !== 'payment_required') throw new Error('unreachable');
    if (result.challenge.rail !== 'x402') throw new Error('unreachable');
    expect(result.challenge.accepts).toEqual([USDC, NANO]);
  });
});

describe('isValidNanoAddress', () => {
  it('accepts checksummed nano_ and xrb_ accounts', () => {
    expect(isValidNanoAddress(MERCHANT)).toBe(true);
    expect(isValidNanoAddress(MERCHANT.replace('nano_', 'xrb_'))).toBe(true);
    expect(isValidNanoAddress(OTHER)).toBe(true);
  });

  it('rejects a bad checksum, bad alphabet, or wrong length', () => {
    expect(isValidNanoAddress(MERCHANT.slice(0, -1) + '4')).toBe(false);
    expect(isValidNanoAddress(MERCHANT.replace('3t6k', '3t6l'))).toBe(false);
    expect(isValidNanoAddress(MERCHANT.slice(0, -1))).toBe(false);
    expect(isValidNanoAddress('0xMerchant')).toBe(false);
  });
});

describe('nanoRequirement', () => {
  it('builds a nano:mainnet entry', () => {
    expect(
      nanoRequirement({
        payTo: MERCHANT.replace('nano_', 'xrb_'),
        amountRaw: PRICE,
        resource: '/widgets',
        maxTimeoutSeconds: 60,
      }),
    ).toEqual({
      scheme: 'exact',
      network: 'nano:mainnet',
      maxAmountRequired: PRICE,
      asset: 'XNO',
      payTo: MERCHANT,
      resource: '/widgets',
      maxTimeoutSeconds: 60,
    });
  });

  it('advertises the default recency window', () => {
    expect(NANO.maxTimeoutSeconds).toBe(DEFAULT_NANO_MAX_TIMEOUT_SECONDS);
  });

  it('throws on a bad address or amount', () => {
    const base = {payTo: MERCHANT, amountRaw: PRICE, resource: '/w'};
    expect(() => nanoRequirement({...base, payTo: OTHER + 'x'})).toThrow(
      /address/,
    );
    expect(() => nanoRequirement({...base, amountRaw: '0'})).toThrow(/amount/);
    expect(() => nanoRequirement({...base, amountRaw: '1.5'})).toThrow(
      /amount/,
    );
    expect(() => nanoRequirement({...base, maxTimeoutSeconds: 0})).toThrow(
      /maxTimeoutSeconds/,
    );
  });
});

describe('FetchNanoRpc', () => {
  it('posts block_info with json_block and returns the body', async () => {
    const requests: {url: string; body: unknown}[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      requests.push({url, body: JSON.parse(String(init.body))});
      return new Response(JSON.stringify(block({})), {status: 200});
    }) as unknown as typeof fetch;
    const node = new FetchNanoRpc({url: 'https://node.test', fetch: fakeFetch});
    const info = await node.blockInfo(SEND);
    expect(info?.confirmed).toBe('true');
    expect(requests).toEqual([
      {
        url: 'https://node.test',
        body: {action: 'block_info', json_block: 'true', hash: SEND},
      },
    ]);
  });

  it('resolves undefined for a block the node does not know', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({error: 'Block not found'}), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(
      await new FetchNanoRpc({fetch: fakeFetch}).blockInfo(SEND),
    ).toBeUndefined();
  });

  it('throws on an HTTP or RPC error', async () => {
    const respond = (body: unknown, status = 200) =>
      (async () =>
        new Response(JSON.stringify(body), {
          status,
        })) as unknown as typeof fetch;
    await expect(
      new FetchNanoRpc({fetch: respond({}, 502)}).blockInfo(SEND),
    ).rejects.toThrow(/502/);
    await expect(
      new FetchNanoRpc({
        fetch: respond({error: 'Unable to parse JSON'}),
      }).blockInfo(SEND),
    ).rejects.toThrow(/Unable to parse JSON/);
  });
});
