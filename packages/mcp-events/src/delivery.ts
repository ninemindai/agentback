// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {
  CallbackEndpointError,
  MAX_EVENT_BYTES,
  McpEventError,
  McpEventErrorCodes,
  type CallbackFailureReason,
  type EventDelivery,
  type EventOccurrence,
  type EventSubscription,
  type SubscriptionStore,
  type VerificationTarget,
} from '@agentback/mcp';
import {
  defineQueue,
  type JobContext,
  type JobQueue,
  type Subscription,
} from '@agentback/messaging';
import {z} from 'zod';
import {constantTimeEqual, signWebhook} from './signing.js';
import {
  statusReason,
  TransportError,
  type WebhookRequest,
  type WebhookTransport,
} from './transport.js';

const log = loggers('agentback:mcp-events:delivery');

/**
 * Largest delivery body sent (256 KiB, the profile's limit). The same value
 * as `MAX_EVENT_BYTES` in `@agentback/mcp`, whose `emit` already refuses a
 * larger occurrence; checked again here for a direct `deliver()` caller.
 */
export const MAX_DELIVERY_BYTES = MAX_EVENT_BYTES;

/**
 * The job queue deliveries ride on. Each job is one occurrence for one
 * subscription, carrying the body **already serialized**: the bytes signed on
 * every attempt are exactly the bytes enqueued once.
 */
export const WEBHOOK_DELIVERY_QUEUE = defineQueue(
  'agentback.mcp-events.webhook',
  z.object({
    subscriptionId: z.string(),
    eventId: z.string(),
    body: z.string(),
  }),
);

/** A delivery job's payload. */
export type WebhookDeliveryJob = z.infer<typeof WEBHOOK_DELIVERY_QUEUE.schema>;

/** What became of one delivery attempt (see `onDeliveryResult`). */
export interface DeliveryResult {
  subscriptionId: string;
  eventId: string;
  /** 1-based attempt number. */
  attempt: number;
  /**
   * `delivered` (2xx); `retry` (will be attempted again); `final_failure`
   * (`410`, `413`, a redirect, or attempts exhausted); `gone` (the
   * subscription was unsubscribed, expired or revoked before this attempt).
   */
  outcome: 'delivered' | 'retry' | 'final_failure' | 'gone';
  /** The failure category, for `retry` and `final_failure`. */
  reason?: CallbackFailureReason | 'error';
  /** The endpoint's status, when it answered. */
  status?: number;
}

/** Retry and transport policy for {@link WebhookEventDelivery}. */
export interface WebhookDeliveryOptions {
  /** Per-attempt timeout, connect to response (default 5 s). */
  timeoutMs?: number;
  /** Attempts per delivery, the first included (default 4). */
  attempts?: number;
  /**
   * First retry delay; doubles each attempt (default 30 s, so 4 attempts span
   * about 3.5 minutes — inside the 10–15 minute window the profile allows).
   */
  backoffMs?: number;
  /** Worker concurrency (default 8). */
  concurrency?: number;
  /**
   * Verification POSTs one principal may trigger per destination host per
   * minute (default 10), successful or not.
   */
  verificationsPerPrincipalPerMinute?: number;
  /**
   * FAILED verifications per destination host per minute, across all
   * principals (default 10). The handshake is attacker-triggerable by
   * subscribing a victim's URL, so failures are capped at the victim's host;
   * a successful echo is consent and is not counted, so a shared receiver
   * (one gateway host serving many users) is never locked out by volume.
   */
  failedVerificationsPerHostPerMinute?: number;
  /**
   * Called after every delivery attempt — wire it to metrics or an alert.
   * Errors it throws are logged and ignored.
   */
  onDeliveryResult?: (result: DeliveryResult) => void;
  /** Clock, in epoch ms (for tests). */
  now?: () => number;
}

interface Resolved {
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
  concurrency: number;
  verificationsPerPrincipalPerMinute: number;
  failedVerificationsPerHostPerMinute: number;
  onDeliveryResult?: (result: DeliveryResult) => void;
  now: () => number;
}

/** Thrown by a failed attempt so the queue retries it. */
class RetryableDeliveryError extends Error {}

/**
 * Webhook delivery for MCP Events: the endpoint verification handshake and
 * signed, retried deliveries. Implements `@agentback/mcp`'s `EventDelivery`
 * port; `installMcpEvents` binds it.
 *
 * Retries reuse `@agentback/messaging`: a delivery is a `JobQueue` job with
 * `attempts` and exponential `backoff`, under a job id derived from
 * `(subscription, eventId)` — colon-free, since BullMQ rejects most ids with
 * a `:` — so a re-emit of an event still pending for a subscription is not
 * queued twice. Finished jobs are removed (`removeOnComplete`/`removeOnFail`),
 * so the queue never accumulates bodies; a re-emit after completion is
 * delivered again with the same `webhook-id`, which receivers dedupe on.
 * With a durable queue, retries also survive a restart. Each attempt:
 *
 * 1. re-reads the subscription — gone (unsubscribed or expired, or deleted
 *    by a later emit's revocation check) means stop, so nothing is delivered
 *    past `refreshBefore`;
 * 2. signs the stored body with a **fresh** `webhook-timestamp` (receivers
 *    reject stale ones) under the current secret, plus the previous one
 *    during a rotation grace window — the `webhook-id` stays the `eventId`;
 * 3. POSTs through the IP-pinned transport. `2xx` is done; `410`, `413` and
 *    a redirect (never followed, so a retry cannot change it) are final;
 *    anything else is retried until `attempts` run out.
 */
export class WebhookEventDelivery implements EventDelivery {
  private readonly opts: Resolved;
  /** Recent verification timestamps, keyed `p:<principal>|<host>` / `h:<host>`. */
  private readonly verifyLog = new Map<string, number[]>();

  constructor(
    private readonly transport: WebhookTransport,
    private readonly queue: JobQueue,
    private readonly store: () => Promise<SubscriptionStore>,
    options: WebhookDeliveryOptions = {},
  ) {
    this.opts = {
      timeoutMs: options.timeoutMs ?? 5_000,
      attempts: options.attempts ?? 4,
      backoffMs: options.backoffMs ?? 30_000,
      concurrency: options.concurrency ?? 8,
      verificationsPerPrincipalPerMinute:
        options.verificationsPerPrincipalPerMinute ?? 10,
      failedVerificationsPerHostPerMinute:
        options.failedVerificationsPerHostPerMinute ?? 10,
      onDeliveryResult: options.onDeliveryResult,
      now: options.now ?? Date.now,
    };
  }

  /** Start the queue worker. The returned handle stops it. */
  start(): Subscription {
    return this.queue.process(
      WEBHOOK_DELIVERY_QUEUE,
      job => this.attempt(job),
      {
        concurrency: this.opts.concurrency,
      },
    );
  }

  /**
   * The challenge handshake: a single-use nonce in a signed
   * `{"type":"verification","challenge":…}` POST, which the endpoint must
   * echo in a `2xx` JSON body. Compared in constant time. Any failure is a
   * `CallbackEndpointError` carrying only a category — never the endpoint's
   * own response, so this is no oracle for an attacker-chosen URL. The
   * operator's log does get the cause.
   */
  async verify(
    target: VerificationTarget,
    opts: {signal?: AbortSignal} = {},
  ): Promise<void> {
    const host = new URL(target.url).host;
    const principalKey = `p:${target.principal}|${host}`;
    const hostKey = `h:${host}`;
    this.assertBudget(
      principalKey,
      this.opts.verificationsPerPrincipalPerMinute,
      'verifications',
    );
    this.assertBudget(
      hostKey,
      this.opts.failedVerificationsPerHostPerMinute,
      'failed_verifications',
    );
    this.charge(principalKey);
    try {
      await this.handshake(target, opts.signal);
    } catch (err) {
      this.charge(hostKey);
      throw err;
    }
  }

  private async handshake(
    target: VerificationTarget,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const challenge = randomToken(32);
    const body = JSON.stringify({type: 'verification', challenge});
    const id = `msg_verification_${randomToken(16)}`;
    const fail = (reason: CallbackFailureReason, detail: string): never => {
      log.warn(
        'verification of %s for %s failed: %s (%s)',
        target.url,
        target.subscriptionId,
        reason,
        detail,
      );
      throw new CallbackEndpointError(reason);
    };
    let res;
    try {
      res = await this.transport(
        await this.signed(
          target.url,
          target.subscriptionId,
          id,
          [target.secret],
          body,
          signal,
        ),
      );
    } catch (err) {
      if (err instanceof TransportError) {
        const hint = /non-public address/.test(err.message)
          ? '; for local development use createPinnedTransport({allowPrivateAddresses: true, ca})'
          : '';
        fail(err.reason, `${err.message}${hint}`);
      }
      throw err;
    }
    if (res.status < 200 || res.status > 299) {
      fail(statusReason(res.status), `HTTP ${res.status}`);
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(res.body) as {challenge?: unknown}).challenge;
    } catch {
      echoed = undefined;
    }
    if (typeof echoed !== 'string' || !constantTimeEqual(echoed, challenge)) {
      fail(
        'challenge_failed',
        'the 2xx body did not echo {"challenge": <nonce>}',
      );
    }
  }

  /**
   * Enqueue one occurrence for one subscription. The body is serialized here,
   * once. A body over 256 KiB throws — `emit` refuses one before it gets
   * here, and a receiver may answer `413`, which is never retried.
   */
  async deliver(
    sub: EventSubscription,
    occurrence: EventOccurrence,
  ): Promise<void> {
    const body = JSON.stringify(occurrence);
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > MAX_DELIVERY_BYTES) {
      throw new Error(
        `event ${occurrence.eventId} is ${bytes} bytes, over the ` +
          `${MAX_DELIVERY_BYTES}-byte delivery limit`,
      );
    }
    await this.queue.enqueue(
      WEBHOOK_DELIVERY_QUEUE,
      {subscriptionId: sub.id, eventId: occurrence.eventId, body},
      {
        jobId: await deliveryJobId(sub.id, occurrence.eventId),
        attempts: this.opts.attempts,
        backoff: {type: 'exponential', delayMs: this.opts.backoffMs},
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  /** One delivery attempt (the queue's processor). */
  async attempt(job: JobContext<WebhookDeliveryJob>): Promise<void> {
    const {subscriptionId, eventId, body} = job.data;
    const attempt = job.attempt + 1;
    const report = (
      r: Omit<DeliveryResult, 'subscriptionId' | 'eventId' | 'attempt'>,
    ) => {
      if (r.outcome === 'final_failure') {
        log.error(
          'delivery %s to %s abandoned after attempt %d (%s)',
          eventId,
          subscriptionId,
          attempt,
          r.reason ?? r.status,
        );
      }
      try {
        this.opts.onDeliveryResult?.({subscriptionId, eventId, attempt, ...r});
      } catch (err) {
        log.warn('onDeliveryResult threw: %s', (err as Error).message);
      }
    };
    const sub = await (await this.store()).get(subscriptionId);
    if (!sub) {
      log.debug(
        'subscription %s is gone; dropping %s',
        subscriptionId,
        eventId,
      );
      report({outcome: 'gone'});
      return;
    }
    const lastAttempt = attempt >= this.opts.attempts;
    const now = this.opts.now();
    const secrets = [sub.secret];
    if (sub.previousSecret && sub.previousSecret.until > now) {
      secrets.push(sub.previousSecret.secret);
    }
    let status: number;
    try {
      const res = await this.transport(
        await this.signed(sub.url, sub.id, eventId, secrets, body, job.signal),
      );
      status = res.status;
    } catch (err) {
      const reason = err instanceof TransportError ? err.reason : 'error';
      log.warn(
        'delivery %s to %s failed (%s), attempt %d',
        eventId,
        sub.id,
        reason,
        attempt,
      );
      report({outcome: lastAttempt ? 'final_failure' : 'retry', reason});
      throw new RetryableDeliveryError(reason, {cause: err});
    }
    if (status >= 200 && status <= 299) {
      report({outcome: 'delivered', status});
      return;
    }
    if (status === 410 || status === 413 || (status >= 300 && status <= 399)) {
      log.info(
        'delivery %s to %s refused with %d; not retried',
        eventId,
        sub.id,
        status,
      );
      report({outcome: 'final_failure', reason: statusReason(status), status});
      return;
    }
    log.warn(
      'delivery %s to %s answered %d, attempt %d',
      eventId,
      sub.id,
      status,
      attempt,
    );
    report({
      outcome: lastAttempt ? 'final_failure' : 'retry',
      reason: statusReason(status),
      status,
    });
    throw new RetryableDeliveryError(statusReason(status));
  }

  private async signed(
    url: string,
    subscriptionId: string,
    id: string,
    secrets: string[],
    body: string,
    signal?: AbortSignal,
  ): Promise<WebhookRequest> {
    const timestamp = Math.floor(this.opts.now() / 1000);
    return {
      url,
      body,
      timeoutMs: this.opts.timeoutMs,
      signal,
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': await signWebhook(secrets, id, timestamp, body),
        'x-mcp-subscription-id': subscriptionId,
      },
    };
  }

  /** Throw `-32013` when `key` has used `max` slots in the last minute. */
  private assertBudget(key: string, max: number, limit: string): void {
    const now = this.opts.now();
    const recent = (this.verifyLog.get(key) ?? []).filter(
      t => t > now - 60_000,
    );
    this.verifyLog.set(key, recent);
    if (recent.length >= max) {
      throw new McpEventError(
        McpEventErrorCodes.ResourceExhausted,
        'Too many endpoint verifications; retry later',
        {limit, max},
      );
    }
  }

  private charge(key: string): void {
    const now = this.opts.now();
    const recent = this.verifyLog.get(key) ?? [];
    recent.push(now);
    this.verifyLog.set(key, recent);
    // Bound the map: forget keys with no entry in the last minute.
    if (this.verifyLog.size > 1_000) {
      for (const [k, times] of this.verifyLog) {
        if (!times.some(t => t > now - 60_000)) this.verifyLog.delete(k);
      }
    }
  }
}

/**
 * The job id for one occurrence to one subscription: stable, fixed-length,
 * and free of `:` (BullMQ rejects a custom id containing one unless it has
 * exactly three parts) whatever the caller's `eventId` holds.
 */
export async function deliveryJobId(
  subscriptionId: string,
  eventId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${subscriptionId}\n${eventId}`),
  );
  return `whk_${[...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 40)}`;
}

function randomToken(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
