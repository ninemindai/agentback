// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  CallbackEndpointError,
  InMemorySubscriptionStore,
  McpEventError,
  McpEventErrorCodes,
  type EventOccurrence,
  type EventSubscription,
} from '@agentback/mcp';
import {InMemoryJobQueue, type Subscription} from '@agentback/messaging';
import {securityId, type UserProfile} from '@agentback/security';
import {MAX_DELIVERY_BYTES, WebhookEventDelivery} from '../../delivery.js';
import {generateWebhookSecret, verifyWebhook} from '../../signing.js';
import {
  TransportError,
  type WebhookRequest,
  type WebhookResponse,
} from '../../transport.js';

const SECRET = generateWebhookSecret();
const URL1 = 'https://hooks.example.com/in';

/** A transport scripted with responses, recording every request. */
function scripted(...answers: Array<WebhookResponse | Error>) {
  const requests: WebhookRequest[] = [];
  const transport = async (req: WebhookRequest): Promise<WebhookResponse> => {
    requests.push(req);
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return next;
  };
  return {transport, requests};
}

/** Echo the verification challenge, as a willing endpoint does. */
const echo = async (req: WebhookRequest): Promise<WebhookResponse> => ({
  status: 200,
  body: JSON.stringify({challenge: JSON.parse(req.body).challenge}),
});

const workers: Subscription[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) await w.close();
});

function subscription(
  over: Partial<EventSubscription> = {},
): EventSubscription {
  return {
    id: 'sub_1',
    principal: 'u1',
    user: {[securityId]: 'u1'} as UserProfile,
    name: 'comment.created',
    arguments: {},
    url: URL1,
    secret: SECRET,
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
    refreshedAt: Date.now(),
    ...over,
  };
}

function occurrence(over: Partial<EventOccurrence> = {}): EventOccurrence {
  return {
    eventId: 'evt_1',
    name: 'comment.created',
    timestamp: '2026-10-01T00:00:00.000Z',
    data: {comment_id: 'c1'},
    cursor: null,
    ...over,
  };
}

async function given(
  transport: (req: WebhookRequest) => Promise<WebhookResponse>,
  opts: {now?: () => number; attempts?: number} = {},
) {
  const store = new InMemorySubscriptionStore();
  const delivery = new WebhookEventDelivery(
    transport,
    new InMemoryJobQueue(),
    async () => store,
    {backoffMs: 5, attempts: opts.attempts ?? 4, now: opts.now},
  );
  workers.push(delivery.start());
  return {store, delivery};
}

function headersOf(req: WebhookRequest) {
  return {
    'webhook-id': req.headers['webhook-id'],
    'webhook-timestamp': req.headers['webhook-timestamp'],
    'webhook-signature': req.headers['webhook-signature'],
  };
}

describe('WebhookEventDelivery.verify', () => {
  const target = {
    subscriptionId: 'sub_1',
    principal: 'u1',
    url: URL1,
    secret: SECRET,
  };

  it('sends a signed verification envelope and accepts an exact echo', async () => {
    const requests: WebhookRequest[] = [];
    const {delivery} = await given(async req => {
      requests.push(req);
      return echo(req);
    });
    await delivery.verify(target);
    const req = requests[0]!;
    const body = JSON.parse(req.body);
    expect(body).toEqual({type: 'verification', challenge: expect.any(String)});
    expect(body.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(req.headers['webhook-id']).toMatch(/^msg_verification_[0-9a-f]+$/);
    expect(req.headers['x-mcp-subscription-id']).toBe('sub_1');
    expect(req.headers['content-type']).toBe('application/json');
    expect(await verifyWebhook(SECRET, headersOf(req), req.body)).toBe(true);
  });

  it.each([
    [
      'a wrong echo',
      {status: 200, body: '{"challenge":"nope"}'},
      'challenge_failed',
    ],
    ['a non-JSON body', {status: 200, body: 'ok'}, 'challenge_failed'],
    ['a 404', {status: 404, body: ''}, 'http_4xx'],
    ['a redirect', {status: 302, body: ''}, 'http_4xx'],
    ['a 503', {status: 503, body: ''}, 'http_5xx'],
    ['a timeout', new TransportError('timeout', 't'), 'timeout'],
    [
      'a refused connection',
      new TransportError('connection_refused', 'r'),
      'connection_refused',
    ],
    ['a TLS failure', new TransportError('tls_error', 't'), 'tls_error'],
  ] as const)('refuses %s with %s', async (_l, answer, reason) => {
    const {delivery} = await given(scripted(answer as never).transport);
    const err = await delivery.verify(target).catch(e => e);
    expect(err).toBeInstanceOf(CallbackEndpointError);
    expect(err).toMatchObject({
      code: McpEventErrorCodes.CallbackEndpointError,
      data: {reason},
    });
  });

  it('rate-limits verification POSTs per destination host', async () => {
    let now = 1_000_000;
    const {delivery} = await given(echo, {now: () => now});
    for (let i = 0; i < 10; i++) await delivery.verify(target);
    const err = await delivery.verify(target).catch(e => e);
    expect(err).toBeInstanceOf(McpEventError);
    expect(err).toMatchObject({
      code: McpEventErrorCodes.ResourceExhausted,
      data: {limit: 'verifications', max: 10},
    });
    // Another host is unaffected; the window slides.
    await delivery.verify({...target, url: 'https://other.example.com/in'});
    now += 61_000;
    await delivery.verify(target);
  });
});

describe('WebhookEventDelivery.deliver', () => {
  it('POSTs the occurrence once, signed, with the routing headers', async () => {
    const {transport, requests} = scripted({status: 204, body: ''});
    const {store, delivery} = await given(transport);
    const sub = subscription();
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const req = requests[0]!;
    expect(JSON.parse(req.body)).toEqual(occurrence());
    expect(req.url).toBe(URL1);
    expect(req.headers['webhook-id']).toBe('evt_1');
    expect(req.headers['x-mcp-subscription-id']).toBe('sub_1');
    expect(
      Math.abs(Number(req.headers['webhook-timestamp']) - Date.now() / 1000),
    ).toBeLessThan(5);
    expect(await verifyWebhook(SECRET, headersOf(req), req.body)).toBe(true);
  });

  it('retries a 5xx with the same webhook-id and a fresh timestamp and signature', async () => {
    let now = 1_700_000_000_000;
    const {transport, requests} = scripted(
      {status: 500, body: ''},
      new TransportError('timeout', 't'),
      {status: 200, body: ''},
    );
    const {store, delivery} = await given(
      async req => {
        now += 10_000; // each attempt happens later
        return transport(req);
      },
      {now: () => now},
    );
    const sub = subscription({expiresAt: null});
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    const ids = new Set(requests.map(r => r.headers['webhook-id']));
    const stamps = new Set(requests.map(r => r.headers['webhook-timestamp']));
    const sigs = new Set(requests.map(r => r.headers['webhook-signature']));
    expect(ids).toEqual(new Set(['evt_1']));
    expect(stamps.size).toBe(3);
    expect(sigs.size).toBe(3);
    // The body is the same bytes on every attempt.
    expect(new Set(requests.map(r => r.body)).size).toBe(1);
  });

  it.each([410, 413])('never retries a %d', async status => {
    const {transport, requests} = scripted({status, body: ''});
    const {store, delivery} = await given(transport);
    const sub = subscription();
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise(r => setTimeout(r, 100));
    expect(requests).toHaveLength(1);
  });

  it('gives up after the configured attempts', async () => {
    const {transport, requests} = scripted({status: 502, body: ''});
    const {store, delivery} = await given(transport, {attempts: 3});
    const sub = subscription();
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    await new Promise(r => setTimeout(r, 150));
    expect(requests).toHaveLength(3);
  });

  it('stops retrying once the subscription is gone', async () => {
    const {transport, requests} = scripted({status: 500, body: ''});
    const store = new InMemorySubscriptionStore();
    const sub = subscription();
    // Unsubscribed while the first attempt is in flight; it then fails.
    const delivery = new WebhookEventDelivery(
      async req => {
        await store.delete(sub.id);
        return transport(req);
      },
      new InMemoryJobQueue(),
      async () => store,
      {backoffMs: 5},
    );
    workers.push(delivery.start());
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise(r => setTimeout(r, 150));
    expect(requests).toHaveLength(1);
  });

  it('dual-signs with the previous secret during the rotation grace window', async () => {
    const {transport, requests} = scripted({status: 200, body: ''});
    const {store, delivery} = await given(transport);
    const old = generateWebhookSecret();
    const sub = subscription({
      previousSecret: {secret: old, until: Date.now() + 60_000},
    });
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const req = requests[0]!;
    expect(req.headers['webhook-signature']!.split(' ')).toHaveLength(2);
    expect(await verifyWebhook(old, headersOf(req), req.body)).toBe(true);
    expect(await verifyWebhook(SECRET, headersOf(req), req.body)).toBe(true);
  });

  it('drops an expired previous secret', async () => {
    const {transport, requests} = scripted({status: 200, body: ''});
    const {store, delivery} = await given(transport);
    const sub = subscription({
      previousSecret: {secret: generateWebhookSecret(), until: Date.now() - 1},
    });
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.headers['webhook-signature']!.split(' ')).toHaveLength(
      1,
    );
  });

  it('delivers a duplicate eventId to the same subscription once', async () => {
    const {transport, requests} = scripted({status: 200, body: ''});
    const {store, delivery} = await given(transport);
    const sub = subscription();
    await store.put(sub);
    await delivery.deliver(sub, occurrence());
    await delivery.deliver(sub, occurrence());
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise(r => setTimeout(r, 100));
    expect(requests).toHaveLength(1);
  });

  it('does not send a body over 256 KiB', async () => {
    const {transport, requests} = scripted({status: 200, body: ''});
    const {store, delivery} = await given(transport);
    const sub = subscription();
    await store.put(sub);
    await delivery.deliver(
      sub,
      occurrence({data: {blob: 'x'.repeat(MAX_DELIVERY_BYTES)}}),
    );
    await new Promise(r => setTimeout(r, 100));
    expect(requests).toHaveLength(0);
  });
});
