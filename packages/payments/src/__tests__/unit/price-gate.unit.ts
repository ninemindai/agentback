// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Context} from '@agentback/context';
import {
  getPrice,
  parsePrice,
  price,
  MeteringBindings,
  Meter,
  InMemoryUsageSink,
  createMeteringRestHook,
} from '@agentback/metering';
import {MCP_DISPATCH_HOOK_TAG} from '@agentback/mcp';
import {REST_DISPATCH_HOOK_TAG} from '@agentback/rest';
import {
  createPriceGateMcpHook,
  createPriceGateRestHook,
  installPriceGate,
  PRICE_GATE_MCP_HOOK_KEY,
  PRICE_GATE_REST_HOOK_KEY,
} from '../../price-gate.js';
import type {
  PaymentAuthorization,
  PaymentContext,
  PaymentRail,
} from '../../types.js';

const paid: PaymentAuthorization = {
  status: 'paid',
  receipt: {rail: 'test', success: true, payload: {txHash: '0xabc'}},
};
const unpaid: PaymentAuthorization = {
  status: 'payment_required',
  challenge: {rail: 'x402', x402Version: 1, accepts: []},
};

function recordingRail(verdict: PaymentAuthorization): PaymentRail & {
  contexts: PaymentContext[];
} {
  const contexts: PaymentContext[] = [];
  return {
    name: 'test',
    contexts,
    authorize: async ctx => {
      contexts.push(ctx);
      return verdict;
    },
  };
}

class Tools {
  @price('$0.01')
  paidRoute() {
    return 'paid result';
  }

  freeRoute() {
    return 'free result';
  }
}

function restInfo(headers: Record<string, string> = {}) {
  const responseHeaders = new Headers();
  return {
    info: {
      request: new Request('http://localhost/premium', {
        method: 'GET',
        headers,
      }),
      responseHeaders,
      ctor: Tools,
      methodName: 'paidRoute',
      schemas: {},
    },
    // Back-compat view for the assertions below: read the neutral collector.
    sent: {
      get 'x-payment-response'() {
        return responseHeaders.get('x-payment-response') ?? undefined;
      },
    } as Record<string, string | undefined>,
  };
}

describe('parsePrice', () => {
  it("parses '$0.001' as USD", () => {
    expect(parsePrice('$0.001')).toEqual({amount: '0.001', currency: 'USD'});
  });

  it("parses '<amount> <CURRENCY>'", () => {
    expect(parsePrice('0.5 usdc')).toEqual({amount: '0.5', currency: 'USDC'});
  });

  it('passes a PriceSpec through and rejects garbage', () => {
    expect(parsePrice({amount: '2', currency: 'EUR', units: 3})).toEqual({
      amount: '2',
      currency: 'EUR',
      units: 3,
    });
    expect(() => parsePrice('cheap')).toThrow(/cannot parse/);
  });
});

describe('@price metadata', () => {
  it('is readable per method and absent on unpriced methods', () => {
    expect(getPrice(Tools.prototype, 'paidRoute')).toEqual({
      amount: '0.01',
      currency: 'USD',
    });
    expect(getPrice(Tools.prototype, 'freeRoute')).toBeUndefined();
  });
});

describe('createPriceGateRestHook', () => {
  it('passes unpriced routes through without consulting the rail', async () => {
    const rail = recordingRail(unpaid);
    const hook = createPriceGateRestHook(rail);
    const {info} = restInfo();
    const result = await hook(
      {...info, methodName: 'freeRoute'} as never,
      async () => 'ran',
    );
    expect(result).toBe('ran');
    expect(rail.contexts).toHaveLength(0);
  });

  it('refuses an unpaid priced call with the 402 envelope fields', async () => {
    const hook = createPriceGateRestHook(recordingRail(unpaid));
    const {info} = restInfo();
    await expect(hook(info as never, async () => 'ran')).rejects.toMatchObject({
      statusCode: 402,
      code: 'payment_required',
      challenge: {rail: 'x402'},
    });
  });

  it('runs a paid call, exposes the receipt, and hands the rail the @price', async () => {
    const rail = recordingRail(paid);
    const hook = createPriceGateRestHook(rail);
    const {info, sent} = restInfo({'x-payment': 'BLOB'});
    const result = await hook(info as never, async () => 'ran');
    expect(result).toBe('ran');
    expect(
      JSON.parse(Buffer.from(sent['x-payment-response']!, 'base64').toString()),
    ).toEqual({txHash: '0xabc'});
    expect(rail.contexts[0]).toMatchObject({
      resource: '/premium',
      paymentHeader: 'BLOB',
      price: {amount: '0.01', currency: 'USD'},
    });
  });
});

describe('createPriceGateMcpHook', () => {
  function mcpInfo(methodName: 'paidRoute' | 'freeRoute') {
    return {
      tool: {ctor: Tools, meta: {name: 'paid_tool', methodName}},
      input: {},
      ctx: new Context(),
    };
  }

  it('refuses unpaid priced tools and passes free tools through', async () => {
    const rail = recordingRail(unpaid);
    const hook = createPriceGateMcpHook(rail);
    await expect(
      hook(mcpInfo('paidRoute') as never, async () => 'ran'),
    ).rejects.toMatchObject({code: 'payment_required'});
    await expect(
      hook(mcpInfo('freeRoute') as never, async () => 'ran'),
    ).resolves.toBe('ran');
    expect(rail.contexts).toHaveLength(1);
    expect(rail.contexts[0]!.price).toEqual({amount: '0.01', currency: 'USD'});
  });
});

describe('installPriceGate + metering composition', () => {
  it('binds tagged hooks; metering logs refusals as payment_required with cost', async () => {
    const app = new Context();
    installPriceGate(app, {rail: recordingRail(unpaid)});
    expect(app.findByTag(REST_DISPATCH_HOOK_TAG).map(b => b.key)).toContain(
      PRICE_GATE_REST_HOOK_KEY,
    );
    expect(app.findByTag(MCP_DISPATCH_HOOK_TAG).map(b => b.key)).toContain(
      PRICE_GATE_MCP_HOOK_KEY,
    );

    // Compose: metering hook (outer) wrapping the gate (inner), as in an app
    // where MeteringComponent is added before installPriceGate.
    const sink = new InMemoryUsageSink();
    app.bind(MeteringBindings.METER).to(new Meter(sink));
    const meteringHook = createMeteringRestHook(app);
    const gateHook = await app.get<ReturnType<typeof createPriceGateRestHook>>(
      PRICE_GATE_REST_HOOK_KEY,
    );

    const {info} = restInfo();
    await expect(
      meteringHook(info as never, () =>
        gateHook(info as never, async () => 'ran'),
      ),
    ).rejects.toMatchObject({code: 'payment_required'});

    const events = sink.all();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'payment_required',
      operation: 'Tools.paidRoute',
      cost: {amount: '0.01', currency: 'USD'},
      units: 1,
    });
  });
});
