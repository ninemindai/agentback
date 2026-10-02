# MCP Events — `@event` + webhook delivery

Use when an MCP client (ChatGPT) should be **notified** when something happens
in the app — "a comment was added", "a build failed" — so an agent reacts
without the user present. Webhook delivery mode only (OpenAI's subset of the
MCP Events extension). Full guide: `docs/guides/mcp-events.md`; runnable:
`examples/hello-mcp-events` (`pnpm -F hello-mcp-events demo` prints a delivery).
**Experimental** — tracks a draft spec.

Not this: for in-process pub/sub between services use `@agentback/messaging`
(`defineTopic`, `EventBus`); `@event` is for external MCP clients. To bridge,
emit from an `EventBus` subscriber.

## Declare, emit, install

```ts
import {
  event,
  mcpServer,
  tool,
  MCPBindings,
  MCPComponent,
  type McpEventEmitter,
} from '@agentback/mcp';
import {installMcpEvents} from '@agentback/mcp-events';
import {installMcpHttp} from '@agentback/mcp-http';
import {inject} from '@agentback/core';
import {z} from 'zod';

const Filter = z.object({document_id: z.string()});
const Created = z.object({
  document_id: z.string(),
  comment_id: z.string(),
  preview: z.string(),
});

@mcpServer()
class DocEvents {
  // name + input (subscription arguments) + payload (occurrence data) + scope
  @event('comment.created', {
    description: '…',
    input: Filter,
    payload: Created,
    scope: 'docs:read',
  })
  matches(args: z.infer<typeof Filter>, e: z.infer<typeof Created>) {
    return e.document_id === args.document_id; // the filter: true = deliver
  }
}

@mcpServer()
class CommentTools {
  @tool('add_comment', {input: AddIn})
  async add(
    input: z.infer<typeof AddIn>,
    @inject(MCPBindings.EVENTS) events: McpEventEmitter,
  ) {
    const c = await save(input);
    await events.emit(
      'comment.created',
      {document_id: c.doc, comment_id: c.id, preview: c.text.slice(0, 140)},
      {eventId: `evt_${c.id}`},
    );
    return c;
  }
}

app.component(MCPComponent);
app.service(DocEvents);
app.service(CommentTools);
await installMcpEvents(app); // binds MCPBindings.EVENT_DELIVERY
await installMcpHttp(app, {auth}); // subscriptions need a principal
```

## Rules

- **`@event` mirrors `@tool`.** `input` and `payload` must be `z.object(...)`
  (object roots; checked at `start()`/`buildServer()`). `payload` is required
  and validated at `emit` time — a mismatch throws and nothing is delivered.
  Slots 0/1 of the method are `(args, data)`; `@inject` at slot 2+.
- **Bind `@event` classes at the app level** (`app.service`). The emitter
  discovers from the app context; a `perSession` binder's event is listed to
  that session but cannot be emitted, so subscribing to it answers `-32014`.
- **`emit` throws before delivering** for an unknown name (message lists the
  emittable ones), a payload mismatch, an `eventId` that is not 1–255 visible
  ASCII, or an occurrence over 256 KiB. Its report is
  `{eventId, subscriptions, queued, revoked}`.
- **Only `=== true` matches.** A non-boolean or a throw is "no match" (logged).
  `SecurityBindings.USER` is the subscriber while `match` runs.
- **Webhook subscriptions require a per-user principal** (`-32012`
  otherwise): `AuthInfo.extra.user` (strategyAuth sets it) or `extra.sub`
  (set it in an OAuth `verifier`) — never `clientId`, the OAuth client app
  every user shares. `localPrincipal` counts only on stdio/in-process, never
  for an unauthenticated HTTP caller. Scope-hidden events answer `-32011`
  exactly like unknown ones.
- **State is app-level**: `MCPBindings.SUBSCRIPTION_STORE` (in-memory default,
  bound by `MCPComponent`) — never on the `MCPServer` instance, which is
  rebuilt per request under stateless HTTP. Bind a shared store for
  multi-instance; bind the BullMQ `JobQueue` for durable retries.
- **Identity is `(principal, url, name, canonical arguments)`**; re-subscribing
  is a refresh (same `sub_` id, new TTL, optional secret rotation with a dual
  signature grace window). The `id` is never accepted as input.
- **TTL**: default 1 h, clamped to 60 s – 24 h, never past the token's
  `expiresAt`; `ttlMs: null` → no expiry only with `events.allowNoExpiry` and
  a durable store. Policy lives in
  `app.configure('servers.MCPServer').to({events: {...}})` (also
  `maxSubscriptionsPerPrincipal`, `trustedCallbackOrigins`, …).
- **Delivery** (`@agentback/mcp-events`): verification challenge first (cached
  per `(principal, url)`, budgeted per principal, failures per host); IP-pinned
  transport refuses non-public addresses at connect time and never follows
  redirects; Standard Webhooks `v1,` HMAC signatures; `410`/`413`/3xx final,
  others retried; 256 KiB cap; `onDeliveryResult` reports each attempt. On an
  edge host use `fetchTransport(fetch)` — it cannot pin. A local receiver needs
  `createPinnedTransport({allowPrivateAddresses: true, ca})` (dev only).
- **Revocation**: `@authorize` voters re-run before every delivery (against the
  profile captured at subscribe time, no request context), then
  `MCPBindings.EVENT_ACCESS_CHECK` if bound; `false` deletes the subscription.
- **Payloads are untrusted data** for the receiving agent: a summary + an id
  for a read tool, never a full record or model instructions.
- **Not built**: poll/push modes, `gap`/`terminated` envelopes,
  `deliveryStatus`, replay (`cursor` is always `null`), `v1a` signing.

## Testing

A stub transport is the receiver — no network, no TLS:

```ts
import {
  generateWebhookSecret,
  verifyWebhook,
  type WebhookRequest,
} from '@agentback/mcp-events';

const received: WebhookRequest[] = [];
const transport = async (req: WebhookRequest) => {
  received.push(req);
  const body = JSON.parse(req.body);
  return body.type === 'verification'
    ? {status: 200, body: JSON.stringify({challenge: body.challenge})} // consent
    : {status: 204, body: ''};
};
await installMcpEvents(app, {transport});

const secret = generateWebhookSecret();
await client.request(
  {
    method: 'events/subscribe',
    params: {
      name: 'comment.created',
      arguments: {document_id: 'd1'},
      delivery: {
        mode: 'webhook',
        url: 'https://receiver.example.com/h',
        secret,
      },
    },
  },
  z.any(),
); // client authenticated as a real user
// …trigger the emit, then:
const d = received[1]!;
expect(
  await verifyWebhook(
    secret,
    {
      'webhook-id': d.headers['webhook-id'],
      'webhook-timestamp': d.headers['webhook-timestamp'],
      'webhook-signature': d.headers['webhook-signature'],
    },
    d.body,
  ),
).toBe(true);
```

Deliveries are queued, so poll for them (`await expect.poll(() => received.length).toBe(2)`).
