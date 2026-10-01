# MCP Events — `@event` + webhook delivery

Use when an MCP client (ChatGPT) should be **notified** when something happens
in the app — "a comment was added", "a build failed" — so an agent reacts
without the user present. Webhook delivery mode only (OpenAI's subset of the
MCP Events extension). Full guide: `docs/guides/mcp-events.md`; runnable:
`examples/hello-mcp-events`.

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
- **Only `=== true` matches.** A non-boolean or a throw is "no match" (logged).
  `SecurityBindings.USER` is the subscriber while `match` runs.
- **Webhook subscriptions require an authenticated principal** (`-32012`
  otherwise); `localPrincipal` counts on stdio. Scope-hidden events answer
  `-32011` exactly like unknown ones.
- **State is app-level**: `MCPBindings.SUBSCRIPTION_STORE` (in-memory default,
  bound by `MCPComponent`) — never on the `MCPServer` instance, which is
  rebuilt per request under stateless HTTP. Bind a shared store for
  multi-instance; bind the BullMQ `JobQueue` for durable retries.
- **Identity is `(principal, url, name, canonical arguments)`**; re-subscribing
  is a refresh (same `sub_` id, new TTL, optional secret rotation with a dual
  signature grace window). The `id` is never accepted as input.
- **TTL**: default 1 h, clamped to 60 s – 24 h (`MCPServerConfig.events`);
  `ttlMs: null` → no expiry only with `events.allowNoExpiry` and a durable store.
- **Delivery** (`@agentback/mcp-events`): verification challenge first (cached
  per `(principal, url)`, rate-limited per host); IP-pinned transport refuses
  non-public addresses at connect time and never follows redirects; Standard
  Webhooks `v1,` HMAC signatures; `410`/`413` final, others retried; 256 KiB
  cap. On an edge host use `fetchTransport(fetch)` — it cannot pin.
- **Revocation**: `@authorize` voters re-run before every delivery, then
  `MCPBindings.EVENT_ACCESS_CHECK` if bound; `false` deletes the subscription.
- **Payloads are untrusted data** for the receiving agent: a summary + an id
  for a read tool, never a full record or model instructions.
- **Not built**: poll/push modes, `gap`/`terminated` envelopes,
  `deliveryStatus`, replay (`cursor` is always `null`), `v1a` signing.

## Testing

Pass a stub `transport` to `installMcpEvents` that echoes
`{"challenge": …}` for `{"type":"verification"}` bodies and records the rest;
check deliveries with `verifyWebhook(secret, headers, body)` and mint secrets
with `generateWebhookSecret()`.
