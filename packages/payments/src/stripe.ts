// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  PrincipalRef,
  UsageEvent,
  UsageSink,
} from '@agentback/metering';

/**
 * A Stripe Billing **meter event** (the v1/billing/meter_events shape). The
 * `identifier` is the per-event idempotency key; `payload.value` is the metered
 * quantity for the customer.
 */
export interface StripeMeterEvent {
  event_name: string;
  payload: {stripe_customer_id: string; value: string} & Record<string, string>;
  identifier?: string;
  timestamp?: number;
}

/**
 * The slice of a Stripe client this adapter uses — wrap
 * `stripe.billing.meterEvents.create` (or the REST endpoint). No `stripe`
 * dependency is taken; inject your client, or a fake in tests.
 */
export interface StripeMeterClient {
  createMeterEvent(event: StripeMeterEvent): Promise<unknown>;
}

export interface StripeUsageReporterOptions {
  client: StripeMeterClient;
  /** The Stripe meter's `event_name`. */
  eventName: string;
  /** Resolve a principal to its Stripe customer id; `undefined` skips billing. */
  customerFor: (principal: PrincipalRef) => string | undefined;
  /** Which events to bill. Default: only `status === 'ok'`. */
  billable?: (event: UsageEvent) => boolean;
  /** The metered quantity per event. Default: `event.units`. */
  value?: (event: UsageEvent) => number;
}

/**
 * Reports usage to Stripe metered billing — the enterprise "usage-log →
 * invoice" rail (fiat, no crypto). Unlike x402/MPP this does **not** gate a
 * call; it forwards billable {@link UsageEvent}s to Stripe, which invoices on
 * its own cycle. "Same units, different rail": the events are the ones the
 * metering audit log already produced.
 *
 * Each event's id becomes the Stripe `identifier` (idempotency), so re-reporting
 * the same usage log is safe. Non-`ok` events (`denied`/`error`/`rate_limited`)
 * and principals with no mapped customer are skipped, not billed.
 */
export class StripeUsageReporter {
  private readonly billable: (event: UsageEvent) => boolean;
  private readonly value: (event: UsageEvent) => number;

  constructor(private readonly opts: StripeUsageReporterOptions) {
    this.billable = opts.billable ?? (event => event.status === 'ok');
    this.value = opts.value ?? (event => event.units);
  }

  /** Report a batch (e.g. a replay of the durable usage log). */
  async report(
    events: UsageEvent[],
  ): Promise<{reported: number; skipped: number}> {
    let reported = 0;
    let skipped = 0;
    for (const event of events) {
      const customer = this.billable(event)
        ? this.opts.customerFor(event.principal)
        : undefined;
      if (!customer) {
        skipped++;
        continue;
      }
      await this.opts.client.createMeterEvent({
        event_name: this.opts.eventName,
        identifier: event.id,
        payload: {
          stripe_customer_id: customer,
          value: String(this.value(event)),
        },
      });
      reported++;
    }
    return {reported, skipped};
  }
}

/**
 * A {@link UsageSink} that bills each event to Stripe as it is recorded — the
 * streaming counterpart to {@link StripeUsageReporter}'s batch replay. Compose
 * it with a durable audit sink via `CompositeUsageSink` to both record and bill
 * from one event.
 */
export class StripeMeterSink implements UsageSink {
  constructor(private readonly reporter: StripeUsageReporter) {}

  async record(event: UsageEvent): Promise<void> {
    await this.reporter.report([event]);
  }
}
