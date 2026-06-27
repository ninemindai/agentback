// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import type {UsageEvent} from '@agentback/metering';
import {
  StripeUsageReporter,
  StripeMeterSink,
  type StripeMeterClient,
  type StripeMeterEvent,
} from '../../stripe.js';

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  id: 'evt-1',
  at: '2026-06-08T00:00:00.000Z',
  status: 'ok',
  latencyMs: 5,
  units: 1,
  surface: 'rest',
  operation: 'WidgetController.list',
  principal: {kind: 'client', id: 'svc-1'},
  ...over,
});

/** Records every meter event the reporter sends. */
function fakeClient(): {client: StripeMeterClient; sent: StripeMeterEvent[]} {
  const sent: StripeMeterEvent[] = [];
  return {
    sent,
    client: {
      createMeterEvent: async e => {
        sent.push(e);
      },
    },
  };
}

// Map our principal id → a Stripe customer id; svc-1 is a known customer.
const customerFor = (p: {id: string}) =>
  p.id === 'svc-1' ? 'cus_ABC' : undefined;

function reporter(client: StripeMeterClient, over = {}) {
  return new StripeUsageReporter({
    client,
    eventName: 'api_call',
    customerFor,
    ...over,
  });
}

describe('StripeUsageReporter', () => {
  it('reports a billable event as a Stripe meter event', async () => {
    const {client, sent} = fakeClient();
    const result = await reporter(client).report([event({units: 3})]);

    expect(result).toEqual({reported: 1, skipped: 0});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_name: 'api_call',
      identifier: 'evt-1', // idempotency key = event id
      payload: {stripe_customer_id: 'cus_ABC', value: '3'},
    });
  });

  it('does not bill non-ok events', async () => {
    const {client, sent} = fakeClient();
    const result = await reporter(client).report([
      event({id: 'a', status: 'denied'}),
      event({id: 'b', status: 'rate_limited'}),
      event({id: 'c', status: 'error'}),
    ]);
    expect(result).toEqual({reported: 0, skipped: 3});
    expect(sent).toHaveLength(0);
  });

  it('skips events whose principal maps to no Stripe customer', async () => {
    const {client, sent} = fakeClient();
    const result = await reporter(client).report([
      event({id: 'known', principal: {kind: 'client', id: 'svc-1'}}),
      event({id: 'unknown', principal: {kind: 'user', id: 'nobody'}}),
    ]);
    expect(result).toEqual({reported: 1, skipped: 1});
    expect(sent.map(e => e.payload.stripe_customer_id)).toEqual(['cus_ABC']);
  });

  it('honors a custom value function', async () => {
    const {client, sent} = fakeClient();
    await reporter(client, {value: (e: UsageEvent) => e.latencyMs}).report([
      event({latencyMs: 42}),
    ]);
    expect(sent[0].payload.value).toBe('42');
  });
});

describe('StripeMeterSink', () => {
  it('reports each recorded event to Stripe (a UsageSink)', async () => {
    const {client, sent} = fakeClient();
    const sink = new StripeMeterSink(reporter(client));
    await sink.record(event());
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.stripe_customer_id).toBe('cus_ABC');
  });

  it('silently skips a non-billable event', async () => {
    const {client, sent} = fakeClient();
    const sink = new StripeMeterSink(reporter(client));
    await sink.record(event({status: 'denied'}));
    expect(sent).toHaveLength(0);
  });
});
