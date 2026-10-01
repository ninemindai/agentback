// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The whole MCP Events loop, in process: a client lists and subscribes over
// /mcp; the server verifies the callback endpoint; a tool call emits the
// event; the receiver gets a signed POST it can verify with the secret it
// chose. The "receiver" is a stub transport, so no network or TLS is needed —
// in production the IP-pinned transport sends the same bytes.

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {
  generateWebhookSecret,
  verifyWebhook,
  type WebhookRequest,
} from '@agentback/mcp-events';
import type {RestApplication, RestServer} from '@agentback/rest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {createApp} from '../application.js';

const HOOK = 'https://receiver.example.com/hooks/alice';
const any = z.any();

let app: RestApplication | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

/** A receiver that answers the challenge and records deliveries. */
function stubReceiver() {
  const received: WebhookRequest[] = [];
  const transport = async (req: WebhookRequest) => {
    received.push(req);
    const body = JSON.parse(req.body);
    return body.type === 'verification'
      ? {status: 200, body: JSON.stringify({challenge: body.challenge})}
      : {status: 204, body: ''};
  };
  return {transport, received};
}

async function connect(token?: string) {
  const url = (await app!.get<RestServer>('servers.RestServer')).url;
  const client = new Client(
    {name: 'demo', version: '0.0.0'},
    {versionNegotiation: {mode: 'auto'}},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: {
        headers: token ? {authorization: `Bearer ${token}`} : {},
      },
    }),
  );
  return client;
}

describe('hello-mcp-events', () => {
  it('delivers a signed comment.created to a verified subscriber', async () => {
    const receiver = stubReceiver();
    app = await createApp({port: 0, transport: receiver.transport});
    await app.start();
    const alice = await connect('demo-alice');

    const {events} = await alice.request(
      {method: 'events/list', params: {}},
      any,
    );
    expect(events[0]).toMatchObject({
      name: 'comment.created',
      delivery: ['webhook'],
    });

    const secret = generateWebhookSecret();
    await alice.request(
      {
        method: 'events/subscribe',
        params: {
          name: 'comment.created',
          arguments: {document_id: 'doc-1'},
          delivery: {mode: 'webhook', url: HOOK, secret},
        },
      },
      any,
    );
    expect(JSON.parse(receiver.received[0]!.body).type).toBe('verification');

    await alice.callTool({
      name: 'add_comment',
      arguments: {document_id: 'doc-1', text: 'Typo in section 2.'},
    });
    await expect.poll(() => receiver.received.length).toBe(2);

    const delivery = receiver.received[1]!;
    expect(
      await verifyWebhook(
        secret,
        {
          'webhook-id': delivery.headers['webhook-id'],
          'webhook-timestamp': delivery.headers['webhook-timestamp'],
          'webhook-signature': delivery.headers['webhook-signature'],
        },
        delivery.body,
      ),
    ).toBe(true);
    expect(JSON.parse(delivery.body)).toMatchObject({
      name: 'comment.created',
      data: {
        document_id: 'doc-1',
        comment_id: 'c_1',
        preview: 'Typo in section 2.',
      },
    });
    await alice.close();
  });

  it('keeps the event from callers without docs:read, and anonymous callers cannot subscribe', async () => {
    app = await createApp({port: 0, transport: stubReceiver().transport});
    await app.start();
    const bob = await connect('demo-bob');
    expect(
      (await bob.request({method: 'events/list', params: {}}, any)).events,
    ).toEqual([]);
    const anon = await connect();
    await expect(
      anon.request(
        {
          method: 'events/subscribe',
          params: {
            name: 'comment.created',
            arguments: {document_id: 'doc-1'},
            delivery: {url: HOOK, secret: generateWebhookSecret()},
          },
        },
        any,
      ),
    ).rejects.toMatchObject({code: -32012});
    await bob.close();
    await anon.close();
  });
});
