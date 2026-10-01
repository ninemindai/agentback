// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// `pnpm -F hello-mcp-events demo` — watch one event arrive. Starts the app on
// an ephemeral port with a printing in-process receiver, subscribes as
// demo-alice, calls add_comment, prints the signed delivery and whether its
// signature verifies, then stops. No tunnel, no TLS, no second terminal.

import {
  generateWebhookSecret,
  verifyWebhook,
  type WebhookRequest,
} from '@agentback/mcp-events';
import type {RestServer} from '@agentback/rest';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {z} from 'zod';
import {createApp} from './application.js';

const HOOK = 'https://receiver.example.com/hooks/alice';
const secret = generateWebhookSecret();
let delivered: () => void;
const arrived = new Promise<void>(r => (delivered = r));

/** A receiver that answers the challenge and prints every delivery. */
async function receiver(req: WebhookRequest) {
  const body = JSON.parse(req.body);
  if (body.type === 'verification') {
    console.log('← verification challenge; echoing it back');
    return {status: 200, body: JSON.stringify({challenge: body.challenge})};
  }
  const ok = await verifyWebhook(
    secret,
    {
      'webhook-id': req.headers['webhook-id'],
      'webhook-timestamp': req.headers['webhook-timestamp'],
      'webhook-signature': req.headers['webhook-signature'],
    },
    req.body,
  );
  console.log(`← POST ${req.url}`);
  for (const h of [
    'webhook-id',
    'webhook-timestamp',
    'webhook-signature',
    'x-mcp-subscription-id',
  ]) {
    console.log(`  ${h}: ${req.headers[h]}`);
  }
  console.log(`  ${req.body}`);
  console.log(`  signature verifies: ${ok}`);
  delivered();
  return {status: 204, body: ''};
}

const app = await createApp({port: 0, transport: receiver});
await app.start();
try {
  const url = (await app.get<RestServer>('servers.RestServer')).url;
  const client = new Client(
    {name: 'demo', version: '0.0.0'},
    {versionNegotiation: {mode: 'auto'}},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: {headers: {authorization: 'Bearer demo-alice'}},
    }),
  );
  const {events} = await client.request(
    {method: 'events/list', params: {}},
    z.any(),
  );
  console.log(`→ events/list: ${events.map((e: {name: string}) => e.name)}`);
  const sub = await client.request(
    {
      method: 'events/subscribe',
      params: {
        name: 'comment.created',
        arguments: {document_id: 'doc-1'},
        delivery: {mode: 'webhook', url: HOOK, secret},
      },
    },
    z.any(),
  );
  console.log(`→ subscribed: ${JSON.stringify(sub)}`);
  console.log('→ add_comment on doc-1');
  await client.callTool({
    name: 'add_comment',
    arguments: {document_id: 'doc-1', text: 'Typo in section 2.'},
  });
  await arrived;
  await client.close();
} finally {
  await app.stop();
}
