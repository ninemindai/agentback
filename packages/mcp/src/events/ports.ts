// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {UserProfile} from '@agentback/security';

/**
 * The general-purpose error codes the MCP Events extension defines, in the
 * JSON-RPC implementation-defined server range. `-32602 InvalidParams` is the
 * standard JSON-RPC code and is not repeated here.
 */
export const McpEventErrorCodes = {
  /** Unknown event name, or no subscription matching an unsubscribe key. */
  NotFound: -32011,
  /** No authenticated principal, or the principal is not permitted. */
  Forbidden: -32012,
  /** A server limit was reached; `data.limit` names it. */
  ResourceExhausted: -32013,
  /** A requested feature is not offered; `data.feature` names it. */
  Unsupported: -32014,
  /** The callback endpoint failed verification or was unreachable. */
  CallbackEndpointError: -32015,
} as const;

/**
 * Why a callback endpoint failed. A server-generated category: never a raw
 * response body, header or status line, so the error is not a response oracle
 * for an attacker-chosen URL.
 */
export type CallbackFailureReason =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed';

/**
 * An MCP Events protocol error carrying one of {@link McpEventErrorCodes} and
 * its typed `data`. Thrown by an {@link EventDelivery} (e.g. a verification
 * rate limit) and answered verbatim as the JSON-RPC error of
 * `events/subscribe`.
 */
export class McpEventError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpEventError';
  }
}

/** `-32015`: the callback endpoint failed verification or was unreachable. */
export class CallbackEndpointError extends McpEventError {
  constructor(
    readonly reason: CallbackFailureReason,
    message = `Callback endpoint error: ${reason}`,
  ) {
    super(McpEventErrorCodes.CallbackEndpointError, message, {reason});
    this.name = 'CallbackEndpointError';
  }
}

/**
 * One webhook subscription, keyed by `(principal, url, name, arguments)`.
 * Held by a {@link SubscriptionStore}; every field but `user` is
 * JSON-serializable, and a durable store persists `user` as the profile its
 * own authentication layer can rebuild.
 */
export interface EventSubscription {
  /** Server-derived routing handle (`sub_…`), deterministic over the key. */
  readonly id: string;
  /** Canonical principal id (the subscriber's `securityId`). */
  readonly principal: string;
  /**
   * The subscriber's profile at subscribe time. Delivery re-runs the event's
   * `@authorize` voters against it and binds it as `SecurityBindings.USER`
   * while `match` runs.
   */
  readonly user: UserProfile;
  /** Event type name. */
  readonly name: string;
  /** Subscription arguments exactly as the client sent them. */
  readonly arguments: Record<string, unknown>;
  /** The `https` callback URL. */
  readonly url: string;
  /** Current `whsec_` signing secret. */
  readonly secret: string;
  /**
   * The secret a refresh replaced, kept until `until` (epoch ms) so in-flight
   * deliveries verify under either during rotation.
   */
  readonly previousSecret?: {readonly secret: string; readonly until: number};
  /** Epoch ms at which the subscription lapses; `null` = no expiry. */
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly refreshedAt: number;
}

/**
 * Where webhook subscriptions and the `(principal, url)` verification cache
 * live. App-level by design: a stateless server is rebuilt per request, so an
 * instance-level store would lose a subscription before its first delivery.
 *
 * Implementations hide expired entries: `get`, `listByEvent` and
 * `countByPrincipal` never return or count a subscription past `expiresAt`.
 */
export interface SubscriptionStore {
  /** Insert or replace by `sub.id`. */
  put(sub: EventSubscription): Promise<void>;
  get(id: string): Promise<EventSubscription | undefined>;
  /** True when a live subscription was removed. */
  delete(id: string): Promise<boolean>;
  /** Live subscriptions to one event type. */
  listByEvent(name: string): Promise<EventSubscription[]>;
  /** Live subscriptions held by one principal (for the per-principal cap). */
  countByPrincipal(principal: string): Promise<number>;
  /** True when `(principal, url)` passed endpoint verification recently. */
  isVerified(principal: string, url: string): Promise<boolean>;
  /** Record a successful verification of `(principal, url)` for `ttlMs`. */
  markVerified(principal: string, url: string, ttlMs: number): Promise<void>;
}

/**
 * One event occurrence as delivered — the webhook body. `cursor` is always
 * `null`: replay is not offered, so a client has nothing to persist.
 */
export interface EventOccurrence {
  eventId: string;
  name: string;
  /** ISO 8601. */
  timestamp: string;
  data: Record<string, unknown>;
  cursor: null;
}

/** The endpoint an {@link EventDelivery} is asked to verify. */
export interface VerificationTarget {
  /** The subscription id the verification is for (`X-MCP-Subscription-Id`). */
  subscriptionId: string;
  principal: string;
  url: string;
  secret: string;
}

/**
 * The delivery port. `@agentback/mcp` holds no network code; the webhook
 * implementation (IP-pinned transport, Standard Webhooks signing, retries)
 * is `@agentback/mcp-events`.
 */
export interface EventDelivery {
  /**
   * Prove the endpoint wants deliveries (the challenge handshake). Called on
   * subscribe for a `(principal, url)` not verified recently. Throw a
   * {@link CallbackEndpointError} (or another {@link McpEventError}) to
   * refuse the subscription.
   */
  verify(
    target: VerificationTarget,
    opts?: {signal?: AbortSignal},
  ): Promise<void>;
  /**
   * Accept one occurrence for one subscription. Resolves once the delivery is
   * accepted (e.g. enqueued) — not once the endpoint answered — and never
   * rejects for an endpoint failure, which is the delivery's own retry
   * policy's business.
   */
  deliver(sub: EventSubscription, occurrence: EventOccurrence): Promise<void>;
}

/**
 * Revocation hook consulted before each delivery. `false` deletes the
 * subscription. See `MCPBindings.EVENT_ACCESS_CHECK`.
 */
export type EventAccessCheck = (
  sub: EventSubscription,
) => boolean | Promise<boolean>;

/** Options for {@link McpEventEmitter.emit}. */
export interface EmitOptions {
  /**
   * Stable id for deduplication. Use the upstream's id when there is one
   * (a GitHub delivery GUID, a Stripe `evt_…`): a re-emit of the same id to
   * the same subscription is delivered once. Defaults to a fresh `evt_…`.
   */
  eventId?: string;
  /** When the event occurred. Defaults to now. */
  timestamp?: Date | string;
}

/** What one {@link McpEventEmitter.emit} did. */
export interface EmitReport {
  eventId: string;
  /** Live subscriptions to the event type. */
  subscriptions: number;
  /** Subscriptions whose `match` accepted the occurrence and were handed to delivery. */
  delivered: number;
  /** Subscriptions deleted because their principal's access was revoked. */
  revoked: number;
}

/** The emit port, bound at `MCPBindings.EVENTS`. */
export interface McpEventEmitter {
  /**
   * Emit one occurrence of event type `name`. `data` is validated against the
   * event's `payload` schema first (a mismatch throws, nothing is
   * delivered); the validated value is what subscribers receive.
   */
  emit(name: string, data: unknown, opts?: EmitOptions): Promise<EmitReport>;
}
