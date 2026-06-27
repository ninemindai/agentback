// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {getPrice, type PriceSpec} from '@agentback/metering';
import {MCP_DISPATCH_HOOK_TAG, type McpDispatchHook} from '@agentback/mcp';
import {REST_DISPATCH_HOOK_TAG, type RestDispatchHook} from '@agentback/rest';
import {defaultContextFor} from './mcp.js';
import type {PaymentChallenge, PaymentRail} from './types.js';

/**
 * The `@price` payment gate: one decorator prices an operation, one install
 * gates it behind a {@link PaymentRail}.
 *
 * ```ts
 * @price('$0.001')
 * @tool('search_catalog', {input: SearchIn, output: SearchOut})
 * async search(input: z.infer<typeof SearchIn>) { … }
 *
 * app.component(MeteringComponent);   // bills the calls (order matters —
 * installPriceGate(app, {rail});      // metering wraps the gate, so unpaid
 * ```                                 // calls log as 'payment_required')
 *
 * Unpaid calls to priced operations fail with the framework's
 * machine-actionable error envelope: `code: 'payment_required'`, the rail's
 * challenge under `challenge`, `retryable: true`, and a remediation hint —
 * the same shape on REST (status 402) and MCP (tool error). Unpriced
 * operations pass through untouched, so installing the gate is safe on a
 * mixed surface.
 *
 * Interop note: agents that speak this framework's envelope read
 * `error.challenge`. For callers that require the strict x402 wire shape (a
 * bare challenge object as the 402 body), keep using `paymentMiddleware` on
 * those paths instead.
 */
export interface PriceGateOptions {
  /** The rail that answers `paid?` for priced operations. */
  rail: PaymentRail;
}

/** Build the 402 / tool error a refused call surfaces. */
export function paymentRequiredError(
  challenge: PaymentChallenge,
  price: PriceSpec,
): Error {
  const err = new Error(
    `Payment required: ${price.amount} ${price.currency} per call.`,
  );
  const e = err as Error & {
    statusCode: number;
    code: string;
    challenge: PaymentChallenge;
  };
  e.statusCode = 402;
  e.code = 'payment_required';
  e.challenge = challenge;
  return err;
}

/**
 * REST dispatch hook gating `@price`d routes. Runs inside the metering hook
 * (bind metering first), so refused calls are logged with status
 * `payment_required` and never billed. A settled payment surfaces its
 * receipt in the `x-payment-response` header, mirroring `paymentMiddleware`.
 */
export function createPriceGateRestHook(rail: PaymentRail): RestDispatchHook {
  return async (info, next) => {
    const spec = getPrice(info.ctor.prototype, info.methodName);
    if (!spec) return next();
    const {request} = info;
    const verdict = await rail.authorize({
      method: request.method,
      // pathname + search mirrors Express `req.originalUrl` (path with query).
      resource: (u => u.pathname + u.search)(new URL(request.url)),
      paymentHeader: request.headers.get('x-payment') ?? undefined,
      sessionId: request.headers.get('x-mpp-session') ?? undefined,
      price: spec,
    });
    if (verdict.status === 'payment_required') {
      throw paymentRequiredError(verdict.challenge, spec);
    }
    const detail = JSON.stringify(verdict.receipt.payload ?? {});
    // Neutral header write — the dispatching surface (Express via `res.setHeader`,
    // Web by merging into the `Response`) flushes this after the hook chain.
    info.responseHeaders.set(
      'x-payment-response',
      Buffer.from(detail).toString('base64'),
    );
    return next();
  };
}

/**
 * MCP dispatch hook gating `@price`d tools. The payment proof is read from
 * the per-request context the same way {@link PaidMCPServer} reads it: an
 * explicit `PaymentMcpBindings.REQUEST_PAYMENT` binding, falling back to the
 * `X-PAYMENT` / `X-MPP-SESSION` headers of an MCP-over-HTTP request.
 */
export function createPriceGateMcpHook(rail: PaymentRail): McpDispatchHook {
  return async (info, next) => {
    const spec = getPrice(
      info.tool.ctor.prototype,
      info.tool.meta.methodName as string,
    );
    if (!spec) return next();
    const pctx = await defaultContextFor(info.ctx, info.tool.meta.name);
    const verdict = await rail.authorize({...pctx, price: spec});
    if (verdict.status === 'payment_required') {
      throw paymentRequiredError(verdict.challenge, spec);
    }
    return next();
  };
}

export const PRICE_GATE_REST_HOOK_KEY = 'payments.hooks.rest.priceGate';
export const PRICE_GATE_MCP_HOOK_KEY = 'payments.hooks.mcp.priceGate';

/**
 * Gate every `@price`d route and tool behind the rail. Call AFTER
 * `app.component(MeteringComponent)` (hooks run in bind order; metering must
 * wrap the gate to log refused calls as `payment_required`) and before
 * `app.start()`.
 */
export function installPriceGate(
  app: Context,
  options: PriceGateOptions,
): void {
  app
    .bind(PRICE_GATE_REST_HOOK_KEY)
    .to(createPriceGateRestHook(options.rail))
    .tag(REST_DISPATCH_HOOK_TAG);
  app
    .bind(PRICE_GATE_MCP_HOOK_KEY)
    .to(createPriceGateMcpHook(options.rail))
    .tag(MCP_DISPATCH_HOOK_TAG);
}
