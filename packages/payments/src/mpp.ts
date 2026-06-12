// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  MppSession,
  MppSessionStore,
  PaymentAuthorization,
  PaymentContext,
  PaymentRail,
} from './types.js';

export interface MppRailOptions {
  /** Where pre-authorized sessions live. */
  store: MppSessionStore;
  /** Units this call costs against the session budget. */
  cost: (ctx: PaymentContext) => number;
  /** Clock for expiry checks. Injectable for tests. Default `Date.now`. */
  now?: () => number;
}

/** Default in-memory {@link MppSessionStore} — open sessions, stream against them. */
export class InMemoryMppSessionStore implements MppSessionStore {
  private readonly sessions = new Map<string, MppSession>();

  /** Register a pre-authorized session (the processor does this in production). */
  open(session: MppSession): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): MppSession | undefined {
    return this.sessions.get(id);
  }

  consume(id: string, units: number): void {
    const s = this.sessions.get(id);
    if (s) s.spent += units;
  }
}

/**
 * The MPP (Machine Payments Protocol — Stripe + Tempo) session rail. Instead of
 * settling per call like x402, the caller pre-authorizes a spending session and
 * streams micropayments against it: each call decrements the budget until it is
 * exhausted or expires. A session is exactly the per-principal budget the
 * metering QuotaService models, which is why this rail is a thin layer over a
 * session store — and the natural fit for MCP, where a per-call round-trip is
 * awkward. We never settle: the processor opens/tops-up sessions out of band.
 */
export class MppRail implements PaymentRail {
  name = 'mpp';

  constructor(private readonly opts: MppRailOptions) {}

  async authorize(ctx: PaymentContext): Promise<PaymentAuthorization> {
    const {sessionId} = ctx;
    if (!sessionId) {
      return {
        status: 'payment_required',
        challenge: {rail: 'mpp', reason: 'no_session'},
      };
    }

    const session = await this.opts.store.get(sessionId);
    if (!session) {
      return {
        status: 'payment_required',
        challenge: {rail: 'mpp', reason: 'no_session', sessionId},
      };
    }

    const now = (this.opts.now ?? (() => Date.now()))();
    if (session.expiresAt != null && now > session.expiresAt) {
      return {
        status: 'payment_required',
        challenge: {rail: 'mpp', reason: 'expired', sessionId},
      };
    }

    const cost = this.opts.cost(ctx);
    const newSpent = session.spent + cost;
    if (newSpent > session.limit) {
      return {
        status: 'payment_required',
        challenge: {rail: 'mpp', reason: 'exhausted', sessionId},
      };
    }

    // Capture the new total before consuming — `consume` mutates the session.
    await this.opts.store.consume(sessionId, cost);
    return {
      status: 'paid',
      receipt: {
        rail: 'mpp',
        success: true,
        payload: {
          sessionId,
          spent: newSpent,
          remaining: session.limit - newSpent,
        },
      },
    };
  }
}
