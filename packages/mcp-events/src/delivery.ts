// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {
  CallbackEndpointError,
  McpEventError,
  McpEventErrorCodes,
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

/** Largest delivery body sent (256 KiB, the profile's limit). */
export const MAX_DELIVERY_BYTES = 256 * 1024;

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
   * Verification POSTs allowed per destination host per minute (default
   * 10). The handshake is attacker-triggerable by subscribing a victim's
   * URL, so it is rate-limited at the victim's host, not per principal.
   */
  verificationsPerHostPerMinute?: number;
  /** Clock, in epoch ms (for tests). */
  now?: () => number;
}

interface Resolved {
  timeoutMs: number;
  attempts: number;
  backoffMs: number;
  concurrency: number;
  verificationsPerHostPerMinute: number;
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
 * `attempts` and exponential `backoff`, keyed `jobId = subId:eventId` so a
 * re-emit of the same event to the same subscription is delivered once (with
 * a durable queue, retries also survive a restart). Each attempt:
 *
 * 1. re-reads the subscription — gone (unsubscribed, expired, revoked) means
 *    stop, so nothing is delivered past `refreshBefore`;
 * 2. signs the stored body with a **fresh** `webhook-timestamp` (receivers
 *    reject stale ones) under the current secret, plus the previous one
 *    during a rotation grace window — the `webhook-id` stays the `eventId`;
 * 3. POSTs through the IP-pinned transport. `2xx` is done; `410` and `413`
 *    are final failures, never retried; anything else is retried until
 *    `attempts` run out.
 */
export class WebhookEventDelivery implements EventDelivery {
  private readonly opts: Resolved;
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
      verificationsPerHostPerMinute:
        options.verificationsPerHostPerMinute ?? 10,
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
   * own response, so this is no oracle for an attacker-chosen URL.
   */
  async verify(
    target: VerificationTarget,
    opts: {signal?: AbortSignal} = {},
  ): Promise<void> {
    this.rateLimitVerification(target.url);
    const challenge = randomToken(32);
    const body = JSON.stringify({type: 'verification', challenge});
    const id = `msg_verification_${randomToken(16)}`;
    let res;
    try {
      res = await this.transport(
        await this.signed(
          target.url,
          target.subscriptionId,
          id,
          [target.secret],
          body,
          opts.signal,
        ),
      );
    } catch (err) {
      if (err instanceof TransportError) {
        throw new CallbackEndpointError(err.reason);
      }
      throw err;
    }
    if (res.status < 200 || res.status > 299) {
      throw new CallbackEndpointError(statusReason(res.status));
    }
    let echoed: unknown;
    try {
      echoed = (JSON.parse(res.body) as {challenge?: unknown}).challenge;
    } catch {
      echoed = undefined;
    }
    if (typeof echoed !== 'string' || !constantTimeEqual(echoed, challenge)) {
      throw new CallbackEndpointError('challenge_failed');
    }
  }

  /**
   * Enqueue one occurrence for one subscription. The body is serialized here,
   * once; a body over 256 KiB is dropped and logged, since a receiver may
   * answer `413` and a `413` is never retried — sending it would only cost the
   * endpoint a request.
   */
  async deliver(
    sub: EventSubscription,
    occurrence: EventOccurrence,
  ): Promise<void> {
    const body = JSON.stringify(occurrence);
    const bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > MAX_DELIVERY_BYTES) {
      log.error(
        'event %s is %d bytes, over the %d-byte delivery limit; not sent to %s',
        occurrence.eventId,
        bytes,
        MAX_DELIVERY_BYTES,
        sub.id,
      );
      return;
    }
    await this.queue.enqueue(
      WEBHOOK_DELIVERY_QUEUE,
      {subscriptionId: sub.id, eventId: occurrence.eventId, body},
      {
        jobId: `${sub.id}:${occurrence.eventId}`,
        attempts: this.opts.attempts,
        backoff: {type: 'exponential', delayMs: this.opts.backoffMs},
      },
    );
  }

  /** One delivery attempt (the queue's processor). */
  async attempt(job: JobContext<WebhookDeliveryJob>): Promise<void> {
    const {subscriptionId, eventId, body} = job.data;
    const sub = await (await this.store()).get(subscriptionId);
    if (!sub) {
      log.debug(
        'subscription %s is gone; dropping %s',
        subscriptionId,
        eventId,
      );
      return;
    }
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
        job.attempt + 1,
      );
      throw new RetryableDeliveryError(reason, {cause: err});
    }
    if (status >= 200 && status <= 299) return;
    if (status === 410 || status === 413) {
      log.info(
        'delivery %s to %s refused with %d; not retried',
        eventId,
        sub.id,
        status,
      );
      return;
    }
    log.warn(
      'delivery %s to %s answered %d, attempt %d',
      eventId,
      sub.id,
      status,
      job.attempt + 1,
    );
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

  private rateLimitVerification(url: string): void {
    const host = new URL(url).host;
    const now = this.opts.now();
    const recent = (this.verifyLog.get(host) ?? []).filter(
      t => t > now - 60_000,
    );
    if (recent.length >= this.opts.verificationsPerHostPerMinute) {
      this.verifyLog.set(host, recent);
      throw new McpEventError(
        McpEventErrorCodes.ResourceExhausted,
        'Too many endpoint verifications for this host; retry later',
        {limit: 'verifications', max: this.opts.verificationsPerHostPerMinute},
      );
    }
    recent.push(now);
    this.verifyLog.set(host, recent);
    // Bound the map: forget hosts with no verification in the last minute.
    if (this.verifyLog.size > 1_000) {
      for (const [h, times] of this.verifyLog) {
        if (!times.some(t => t > now - 60_000)) this.verifyLog.delete(h);
      }
    }
  }
}

function randomToken(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
