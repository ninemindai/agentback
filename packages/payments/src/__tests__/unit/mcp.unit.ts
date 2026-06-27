// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Context} from '@agentback/context';
import {MCPBindings} from '@agentback/mcp';
import {
  gateMcpToolPayment,
  paymentRequiredToolResult,
  PaidMCPServer,
  PaymentMcpBindings,
  MCP_PAYMENT_CHALLENGE_META,
} from '../../mcp.js';
import type {
  PaymentAuthorization,
  PaymentContext,
  PaymentRail,
} from '../../types.js';

/** A rail with a fixed verdict, recording whether it was consulted. */
function fixedRail(verdict: PaymentAuthorization): PaymentRail {
  return {name: 'test', authorize: async () => verdict};
}

const paid: PaymentAuthorization = {
  status: 'paid',
  receipt: {rail: 'test', success: true},
};
const needX402: PaymentAuthorization = {
  status: 'payment_required',
  challenge: {rail: 'x402', x402Version: 1, accepts: []},
};
const needMpp: PaymentAuthorization = {
  status: 'payment_required',
  challenge: {rail: 'mpp', reason: 'no_session'},
};

describe('gateMcpToolPayment', () => {
  it('runs the tool when the call is paid', async () => {
    let ran = false;
    const out = await gateMcpToolPayment(
      fixedRail(paid),
      {method: 'tools/call', resource: 't'},
      async () => {
        ran = true;
        return {ok: true};
      },
    );
    expect(ran).toBe(true);
    expect(out).toEqual({ok: true});
  });

  it('returns a tool error carrying the challenge and skips the tool', async () => {
    let ran = false;
    const out = (await gateMcpToolPayment(
      fixedRail(needX402),
      {method: 'tools/call', resource: 't'},
      async () => {
        ran = true;
        return {ok: true};
      },
    )) as {isError: boolean; _meta: Record<string, unknown>};
    expect(ran).toBe(false); // the tool body never ran
    expect(out.isError).toBe(true);
    expect(out._meta[MCP_PAYMENT_CHALLENGE_META]).toEqual(needX402.challenge);
  });
});

describe('paymentRequiredToolResult', () => {
  it('shapes an MCP isError content result for an x402 challenge', () => {
    const r = paymentRequiredToolResult(needX402.challenge);
    expect(r.isError).toBe(true);
    expect(r.content[0].type).toBe('text');
    expect(r.content[0].text.toLowerCase()).toContain('payment');
    expect(r._meta[MCP_PAYMENT_CHALLENGE_META]).toEqual(needX402.challenge);
  });

  it('mentions the session for an MPP challenge', () => {
    const r = paymentRequiredToolResult(needMpp.challenge);
    expect(r.content[0].text.toLowerCase()).toContain('session');
  });
});

// Light wiring check: a payment-required call returns the error result without
// invoking super.dispatchTool (so no real controller/server is needed).
class TestPaidMCPServer extends PaidMCPServer {
  superCalled = false;
  call(toolName: string, ctx: Context) {
    return this.dispatchTool(
      {ctor: class {}, meta: {name: toolName, methodName: 'run'}},
      {},
      ctx,
    );
  }
  protected override async dispatchToolBase(): Promise<unknown> {
    this.superCalled = true;
    return {ok: true};
  }
}

describe('PaidMCPServer', () => {
  it('gates a paid tool with no proof → returns the challenge error result', async () => {
    const appCtx = new Context('app');
    appCtx.bind(PaymentMcpBindings.OPTIONS).to({
      railFor: (name: string) =>
        name === 'paid' ? fixedRail(needX402) : undefined,
    });
    const server = new TestPaidMCPServer(appCtx);

    const result = (await server.call('paid', new Context(appCtx, 'req'))) as {
      isError: boolean;
    };

    expect(result.isError).toBe(true);
    expect(server.superCalled).toBe(false);
  });

  it('passes a free tool straight through to the base dispatch', async () => {
    const appCtx = new Context('app');
    appCtx.bind(PaymentMcpBindings.OPTIONS).to({railFor: () => undefined});
    const server = new TestPaidMCPServer(appCtx);

    const result = await server.call('free', new Context(appCtx, 'req'));

    expect(server.superCalled).toBe(true);
    expect(result).toEqual({ok: true});
  });

  it('reads payment proof from MCP request headers (end-to-end, no glue)', async () => {
    let seen: PaymentContext | undefined;
    const inspectRail: PaymentRail = {
      name: 'inspect',
      authorize: async c => {
        seen = c;
        return needX402;
      },
    };
    const appCtx = new Context('app');
    appCtx.bind(PaymentMcpBindings.OPTIONS).to({railFor: () => inspectRail});
    const server = new TestPaidMCPServer(appCtx);

    // Simulate what mcp-http binds per request from the transport headers.
    const reqCtx = new Context(appCtx, 'req');
    reqCtx.bind(MCPBindings.REQUEST_INFO).to({
      headers: {'X-PAYMENT': 'pay-blob', 'x-mpp-session': 'sess-9'},
    });
    await server.call('paid', reqCtx);

    expect(seen?.paymentHeader).toBe('pay-blob'); // case-insensitive header read
    expect(seen?.sessionId).toBe('sess-9');
  });
});
