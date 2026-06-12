// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request, RequestHandler, Response} from 'express';
import type {
  PaymentAuthorization,
  PaymentContext,
  PaymentRail,
  PaymentRequirements,
  X402Facilitator,
} from './types.js';

export interface X402RailOptions {
  /** External facilitator that verifies + settles payments (we don't settle). */
  facilitator: X402Facilitator;
  /** Compute the acceptable payment requirements for a given call. */
  requirements: (ctx: PaymentContext) => PaymentRequirements[];
  /** x402 protocol version advertised in challenges. Default 1. */
  x402Version?: number;
}

/**
 * The x402 ({@link https://x402.org | HTTP 402}) payment rail. A call with no
 * `X-PAYMENT` is challenged with the payment requirements; a call that presents
 * one is verified and settled through the {@link X402Facilitator}, yielding a
 * receipt. Per-request, on-chain (typically USDC on an L2) — best for the long
 * tail of cheap calls.
 */
export class X402Rail implements PaymentRail {
  name = 'x402';

  constructor(private readonly opts: X402RailOptions) {}

  async authorize(ctx: PaymentContext): Promise<PaymentAuthorization> {
    const accepts = this.opts.requirements(ctx);
    const x402Version = this.opts.x402Version ?? 1;
    const challenge = (error?: string): PaymentAuthorization => ({
      status: 'payment_required',
      challenge: {
        rail: 'x402',
        x402Version,
        accepts,
        ...(error ? {error} : {}),
      },
    });

    if (!ctx.paymentHeader) return challenge();

    const verified = await this.opts.facilitator.verify(
      ctx.paymentHeader,
      accepts,
    );
    if (!verified.valid) return challenge(verified.reason ?? 'invalid payment');

    const settled = await this.opts.facilitator.settle(
      ctx.paymentHeader,
      accepts,
    );
    if (!settled.success) return challenge('settlement failed');

    return {
      status: 'paid',
      receipt: {rail: 'x402', success: true, payload: settled.payload},
    };
  }
}

/**
 * Express middleware that gates a route behind a {@link PaymentRail}. No/invalid
 * payment → `402` with the challenge body and no `next()`; a settled payment →
 * `X-PAYMENT-RESPONSE` header (base64 receipt detail) and `next()` to run the
 * handler. Mount it like the rate-limit / auth guards.
 */
export function paymentMiddleware(rail: PaymentRail): RequestHandler {
  return (req: Request, res: Response, next) => {
    void (async () => {
      const ctx: PaymentContext = {
        method: req.method,
        resource: req.originalUrl ?? req.url,
        paymentHeader: req.header('x-payment') ?? undefined,
        sessionId: req.header('x-mpp-session') ?? undefined,
      };
      const result = await rail.authorize(ctx);
      if (result.status === 'paid') {
        const detail = JSON.stringify(result.receipt.payload ?? {});
        res.setHeader(
          'x-payment-response',
          Buffer.from(detail).toString('base64'),
        );
        next();
        return;
      }
      res.status(402).json(result.challenge);
    })().catch(next);
  };
}
