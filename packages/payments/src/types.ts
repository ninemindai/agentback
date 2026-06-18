// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * x402 payment requirements (one entry in a 402 `accepts` array). Describes a
 * way to pay for the resource: which scheme/network, how much, in what asset,
 * to whom. Mirrors the Coinbase x402 spec.
 */
export interface PaymentRequirements {
  /** Payment scheme, e.g. `exact`. */
  scheme: string;
  /** Settlement network, e.g. `base` or `base-sepolia`. */
  network: string;
  /** Maximum amount required, in the asset's base units (string for precision). */
  maxAmountRequired: string;
  /** Asset/token contract address (or symbol) to pay in. */
  asset: string;
  /** Recipient address. */
  payTo: string;
  /** The resource being paid for (URL/path). */
  resource: string;
  /** Human-readable description. */
  description?: string;
  /** Expected response MIME type. */
  mimeType?: string;
  /** How long the client has to complete payment. */
  maxTimeoutSeconds?: number;
}

/** The body returned with an HTTP 402 for x402 — what the client must pay. */
export interface X402Challenge {
  rail: 'x402';
  x402Version: number;
  accepts: PaymentRequirements[];
  /** Set when a presented payment was rejected. */
  error?: string;
}

/**
 * Challenge for the MPP session rail: the caller must open or top-up a
 * pre-authorized session before the call can be metered against it.
 */
export interface MppChallenge {
  rail: 'mpp';
  /** Why the call could not proceed. */
  reason: 'no_session' | 'expired' | 'exhausted';
  /** The session that was presented (for `expired` / `exhausted`). */
  sessionId?: string;
  error?: string;
}

/** A payment challenge, discriminated by `rail`. */
export type PaymentChallenge = X402Challenge | MppChallenge;

/** Proof a call was paid for, returned to the caller. */
export interface Receipt {
  rail: string;
  success: boolean;
  /** Rail-specific settlement detail (e.g. x402 tx hash / network). */
  payload?: Record<string, unknown>;
}

/** The minimal request facts a rail needs to decide payment. */
export interface PaymentContext {
  method: string;
  /** The resource URL/path being called. */
  resource: string;
  /** The presented payment (x402 `X-PAYMENT` header), if any. */
  paymentHeader?: string;
  /** The presented MPP session id (`X-MPP-SESSION` header), if any. */
  sessionId?: string;
  /**
   * The declared `@price` of the operation, when the call was gated by the
   * price-gate hooks — so a rail's `requirements` can derive the asked
   * amount from the decorator instead of a parallel price table.
   */
  price?: {amount: string; currency: string; units?: number};
}

/**
 * A pre-authorized MPP spending session. The processor (Stripe + Tempo) opens
 * it out of band with a `limit`; each call streams `spent` against it until it
 * is exhausted or expires. This is the same per-principal budget the metering
 * QuotaService models — the rail just decrements it.
 */
export interface MppSession {
  id: string;
  /** Optional owner; lets a session be tied to a billable principal. */
  principalId?: string;
  /** Authorized budget, in abstract units (calls, or priced units). */
  limit: number;
  /** Units consumed so far. */
  spent: number;
  /** Expiry as Unix ms; omitted = no expiry. */
  expiresAt?: number;
}

/**
 * Store of pre-authorized MPP sessions. The default is in-memory; back it with
 * the processor / a shared store in production. `consume` is only called after
 * a successful budget check.
 */
export interface MppSessionStore {
  get(id: string): MppSession | undefined | Promise<MppSession | undefined>;
  consume(id: string, units: number): void | Promise<void>;
}

/** A rail's verdict for one call. */
export type PaymentAuthorization =
  | {status: 'paid'; receipt: Receipt}
  | {status: 'payment_required'; challenge: PaymentChallenge};

/**
 * A payment rail — the `paid?` answer. `authorize` decides whether a call is
 * paid for, returning either a receipt or a challenge to send back to the
 * caller. Implementations orchestrate settlement through an external
 * facilitator/processor; this package never custodies funds or settles
 * on-chain itself. x402 ships here; MPP (Stripe+Tempo sessions) and Stripe
 * (usage-log invoicing) are the next adapters.
 */
export interface PaymentRail {
  name: string;
  authorize(ctx: PaymentContext): Promise<PaymentAuthorization>;
}

/** Result of an x402 facilitator `/verify` call. */
export interface X402VerifyResult {
  valid: boolean;
  reason?: string;
}

/** Result of an x402 facilitator `/settle` call. */
export interface X402SettleResult {
  success: boolean;
  /** Settlement detail surfaced to the caller (tx hash, network, …). */
  payload?: Record<string, unknown>;
}

/**
 * The external x402 facilitator that verifies a payment authorization and
 * settles it on-chain. Injectable so the rail is testable without a network or
 * a chain; in production point it at a hosted/self-hosted facilitator.
 */
export interface X402Facilitator {
  verify(
    payment: string,
    requirements: PaymentRequirements[],
  ): Promise<X402VerifyResult>;
  settle(
    payment: string,
    requirements: PaymentRequirements[],
  ): Promise<X402SettleResult>;
}
