# Push events to agents with MCP Events

> **Experimental:** `@event`, `events/*` and `@agentback/mcp-events` track
> the MCP Events WG sketch and OpenAI's webhook subset, and may change in a
> minor release.

**Outcome:** an MCP client (ChatGPT, or any host speaking the MCP Events
extension) subscribes to something happening in your app — "a comment was
added to document 42" — and your app POSTs each occurrence to the client's
webhook, signed, so an agent can react without the user present.

AgentBack builds the **webhook** delivery mode of the extension: the subset
ChatGPT ships, out of the three modes in the
[WG design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md).
Why that subset, and what was left out, is in
[the proposal](../proposals/mcp-events.md). The runnable version of this guide
is [`examples/hello-mcp-events`](../../examples/hello-mcp-events).

## 1. Declare an event type with `@event`

An event type is a name plus two Zod schemas — the same shape as a `@tool`:

```ts
import {event, mcpServer} from '@agentback/mcp';
import {z} from 'zod';

const CommentFilter = z.object({document_id: z.string()});
const CommentCreated = z.object({
  document_id: z.string(),
  comment_id: z.string(),
  preview: z.string(),
});

@mcpServer()
export class DocEvents {
  @event('comment.created', {
    description: 'A new review comment was added to the specified document.',
    input: CommentFilter, // → inputSchema: the subscription arguments
    payload: CommentCreated, // → payloadSchema: each occurrence's `data`
    scope: 'docs:read', // visibility gate, exactly as on @tool
  })
  matches(
    args: z.infer<typeof CommentFilter>,
    e: z.infer<typeof CommentCreated>,
  ) {
    return e.document_id === args.document_id;
  }
}
```

- **`input`** becomes the event's `inputSchema` on `events/list` and validates
  the `arguments` a client subscribes with. Omit it for an event that takes no
  arguments. Like a tool's input, it must be a `z.object(...)`.
- **`payload`** becomes `payloadSchema` and is validated **when you emit**, so
  every delivered `data` matches what you published. Unknown keys are stripped
  by the schema before anything leaves the process.
- **The method is the filter.** An occurrence reaches a subscription only when
  `match(args, data)` returns `true`. Anything else — `undefined`, a string,
  a thrown error — is "no match", so a filter bug under-delivers instead of
  leaking another subscriber's events. While it runs, `SecurityBindings.USER`
  is the subscriber, so it can also ask "may this person see this
  occurrence?". `@inject(...)` parameters may follow at slot 2+.
- **`scope`** (or `@authorize({scopes})` on the method) hides the event from
  `events/list` and refuses `events/subscribe` for callers without it — the
  same visibility rule as tools. `@authorize` voters also run on subscribe and
  **again before every delivery** (see _Revocation_ below).

Register the class with `app.service(DocEvents)`, as any `@mcpServer`. Bind
it at the **app level**: the emitter discovers events from the app context, so
an event a `perSession` binder contributes is listed to that session but can
never be emitted — `events/subscribe` refuses it with
`-32014 {feature: 'event'}` rather than storing a subscription that never
fires.

`@event` is for **external MCP clients**. For in-process pub/sub between your
own services use `@agentback/messaging` (`defineTopic`, `EventBus`); to bridge
the two, emit from an `EventBus` subscriber.

## 2. Emit

The emitter is an app-level port, `MCPBindings.EVENTS`:

```ts
import {inject} from '@agentback/core';
import {MCPBindings, tool, type McpEventEmitter} from '@agentback/mcp';

@tool('add_comment', {input: AddCommentIn, output: Comment})
async addComment(
  input: z.infer<typeof AddCommentIn>,
  @inject(MCPBindings.EVENTS) events: McpEventEmitter,
) {
  const comment = await this.store.add(input);
  await events.emit(
    'comment.created',
    {document_id: comment.document_id, comment_id: comment.id, preview},
    {eventId: `evt_${comment.id}`}, // the upstream's id dedups re-emits
  );
  return comment;
}
```

`emit` throws, and delivers nothing, if `data` does not match `payload`, if
the event name is unknown (the message lists the emittable ones), if
`eventId` is not 1–255 visible ASCII characters (it becomes the `webhook-id`
header), or if the serialized occurrence exceeds 256 KiB. Then, for each live
subscription, it runs the revocation check and `match`, and hands the
occurrence to delivery. It resolves with
`{eventId, subscriptions, queued, revoked}` once deliveries are **queued**,
not once endpoints answered — retries are the delivery's business. Emitting is
not tied to a request: a job processor, an `EventBus` subscriber or a
webhook from your own upstream can emit just as well.

**Keep payloads small and inert.** Deliveries are capped at 256 KiB, and the
receiving agent treats `data` as untrusted input, like a tool result. Send a
summary plus the id a read tool takes (`get_comment`), never a whole record,
and never instructions for a model.

## 3. Turn on delivery and expose `/mcp`

```ts
import {MCPComponent} from '@agentback/mcp';
import {installMcpEvents} from '@agentback/mcp-events';
import {installMcpHttp} from '@agentback/mcp-http';

app.component(MCPComponent);
app.service(DocEvents);
await installMcpEvents(app);
await installMcpHttp(app, {auth}); // or strategyAuth
```

`installMcpEvents` binds `MCPBindings.EVENT_DELIVERY` and starts the delivery
worker; without it `events/list` still works and `events/subscribe` answers
`-32014 Unsupported`. It returns an `Installed` (`uninstall()` retracts it).

**Webhook subscriptions need an authenticated, per-user principal.** The
principal is part of the subscription's identity — without it, anyone who
guessed `(url, name, arguments)` could unsubscribe someone else or swap their
secret — and the per-principal cap only isolates tenants if it names a
person. So the principal is:

- `AuthInfo.extra.user` (the framework principal `strategyAuth` sets), else
  `AuthInfo.extra.sub` — **set the subject there in an OAuth `verifier`**. A
  token with neither is refused with `-32012`: its `clientId` names the OAuth
  client application (ChatGPT, say), which every one of its users shares.
- `MCPServerConfig.localPrincipal`, but only on stdio and in-process calls.
  An unauthenticated HTTP caller is refused even when one is configured.

A granted TTL never outlives the token: `refreshBefore` is capped at the
token's `expiresAt`, so the client refreshes with a live credential.

## What the client sees

The server advertises `capabilities.events: {}` (top-level, where ChatGPT
looks for it) whenever the app declares an event, on both protocol eras.

```jsonc
// events/list →
{"events": [{
  "name": "comment.created",
  "description": "A new review comment was added to the specified document.",
  "delivery": ["webhook"],
  "inputSchema": {"type": "object", "properties": {"document_id": {"type": "string"}}, …},
  "payloadSchema": {"type": "object", …}
}]}

// events/subscribe →
{"name": "comment.created", "arguments": {"document_id": "42"},
 "delivery": {"mode": "webhook", "url": "https://…", "secret": "whsec_…"},
 "ttlMs": 3600000}
// ← {"id": "sub_3f…", "refreshBefore": "2026-10-01T13:00:00.000Z",
//    "cursor": null, "truncated": false}

// events/unsubscribe → {"name": …, "arguments": …, "delivery": {"url": …}}  ← {}
```

- **Identity, not ids.** A subscription is `(principal, url, name, arguments)`
  (arguments compared as canonical JSON). Subscribing again with the same tuple
  is a **refresh**: same `id`, a new TTL, and possibly a new secret. The `id` is
  a routing handle for the receiver (`X-MCP-Subscription-Id`), never accepted
  as input.
- **TTL.** The client suggests `ttlMs`; the server grants `refreshBefore`:
  the default (1 h) when none is suggested, otherwise clamped into
  `[minTtlMs, maxTtlMs]` (60 s – 24 h), and never past the token's expiry.
  `ttlMs: null` (no expiry) is honoured only with `events.allowNoExpiry`,
  because a server that grants it must keep the subscription across
  restarts — the in-memory store cannot.
- **URLs are normalized** (lower-case host, default port dropped), so
  spellings of one URL are one subscription and one verification.
- **Secret rotation.** A refresh with a new `whsec_` secret keeps the old one
  signing beside it for `secretRotationGraceMs` (5 min): deliveries carry both
  signatures, so in-flight ones verify under either.
- **Replay** is not offered: `cursor` is always `null`.

The policy is `MCPServerConfig.events`:

```ts
app.configure('servers.MCPServer').to({
  events: {defaultTtlMs: 15 * 60_000, maxSubscriptionsPerPrincipal: 20},
});
```

| Field                          | Default | Meaning                                                                      |
| ------------------------------ | ------- | ---------------------------------------------------------------------------- |
| `defaultTtlMs`                 | 1 h     | TTL granted when the client suggests none                                    |
| `minTtlMs`                     | 60 s    | Floor a shorter suggestion is clamped up to                                  |
| `maxTtlMs`                     | 24 h    | Ceiling a longer suggestion is clamped down to                               |
| `allowNoExpiry`                | `false` | Honour `ttlMs: null` — only with a durable store                             |
| `maxSubscriptionsPerPrincipal` | 100     | Live subscriptions per principal (`-32013` past it)                          |
| `secretRotationGraceMs`        | 5 min   | How long a replaced secret keeps signing                                     |
| `verificationTtlMs`            | 1 h     | How long a passed verification covers a `(principal, url)`                   |
| `trustedCallbackOrigins`       | `[]`    | `https` origins treated as verified without a challenge (vetted out of band) |

Errors use the extension's codes: `-32602` (malformed params: non-`https` URL,
URL with credentials, a secret that is not `whsec_` + 24–64 bytes, arguments
that fail `input`), `-32011 {kind: 'event' | 'subscription'}` (unknown or
scope-hidden event; nothing to unsubscribe), `-32012` (no principal, or
`@authorize` denies), `-32013 {limit, max}` (per-principal cap, verification
rate limit), `-32014 {feature, value}` (another delivery mode, delivery not
installed, or an event that cannot be emitted), `-32015 {reason}` (the
endpoint failed verification). The wire errors are terse on purpose; the
server log names the cause and the fix (`DEBUG=agentback:mcp*`).

## How a delivery is made safe

The callback URL is attacker-supplied by design, which is why
`@agentback/mcp-events` is strict:

1. **Endpoint verification before anything is delivered.** HMAC stops forged
   deliveries but not someone subscribing a victim's URL. So the first
   subscribe for a `(principal, url)` POSTs a signed
   `{"type":"verification","challenge":"<nonce>"}`; the endpoint must answer
   `2xx` with `{"challenge":"<nonce>"}` (compared in constant time). The result
   is cached per `(principal, url)` for `verificationTtlMs`, so varying
   `arguments` cannot multiply POSTs at a victim, and concurrent subscribes
   share one handshake. Handshakes are budgeted per principal (10 a minute per
   host) and **failed** ones per destination host (10 a minute): a successful
   echo is consent, so a shared receiver such as ChatGPT's gateway is never
   locked out by volume. A host listed in `trustedCallbackOrigins` skips the
   POST.
2. **The resolved IP is pinned.** The default transport resolves the callback
   host **inside the connection**, refuses if any answer is outside globally
   reachable space (the IANA special-purpose registries), and connects to the
   address it just validated, keeping the hostname for TLS and `Host`. A name
   that was public at subscribe time and rebinds to `169.254.169.254` at
   delivery time is refused. Redirects are never followed.
3. **Standard Webhooks signatures** over the exact bytes sent:
   `webhook-signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`.
   `webhook-id` is the `eventId` (stable across retries, so the receiver
   dedups), and `webhook-timestamp` is fresh on each attempt.
4. **Bounded retries.** Deliveries are `@agentback/messaging` jobs: `2xx` is
   done; `410 Gone`, `413` and a redirect are final; anything else retries
   with exponential backoff (4 attempts by default). Each attempt re-reads
   the subscription, so an unsubscribe, an expiry, or a revocation found by a
   later emit stops it. Finished jobs are removed, so the queue holds only
   pending work. `onDeliveryResult` reports every attempt's outcome
   (`delivered | retry | final_failure | gone`) — wire it to metrics.
5. **Categories, not echoes.** A failure is reported only as
   `connection_refused | timeout | tls_error | http_4xx | http_5xx |
challenge_failed` — never the endpoint's own response.

### Revocation

Before every delivery, the event method's `@authorize` voters run again
against the subscriber's profile, then the optional
`MCPBindings.EVENT_ACCESS_CHECK` hook. A `false` from either deletes the
subscription. The voters see the profile **captured at subscribe time**, in a
context with no request — a voter that reads request-scoped bindings will
deny (and delete) at emit time — so a change in the principal's claims takes
effect at the next refresh (bounded by the granted TTL) unless the hook says
otherwise. Bind the hook to whatever can say a principal's access ended —
token introspection, a revocation list:

```ts
app
  .bind(MCPBindings.EVENT_ACCESS_CHECK)
  .to(async sub => !(await revoked.has(sub.principal)));
```

## Deploying

- **One instance:** the defaults (in-memory subscriptions, in-memory queue)
  fit a single process. A restart drops subscriptions — clients re-subscribe
  on their next refresh, which is why grants are short — and drops retries
  still pending.
- **Several instances:** the in-memory store is per process, so an emit on
  one replica misses subscriptions held by another, and an unsubscribe on one
  does not stop another. Bind a shared `MCPBindings.SUBSCRIPTION_STORE` (the
  `SubscriptionStore` port; the in-memory one is the reference, and every
  record is plain JSON) and the BullMQ `JobQueue` from
  `@agentback/messaging-bullmq`, which `installMcpEvents` picks up from the
  app — retries then survive a restart. A shared store must enforce the
  per-principal cap itself; the in-process lock covers one process.
- **Edge hosts** have no `node:https`; pass
  `installMcpEvents(app, {transport: fetchTransport(fetch)})`. That transport
  **cannot pin the IP** (the platform resolves the name and exposes no hook),
  so restrict egress at the platform, or deliver from a Node host.
- **Feedback loops** are yours to prevent: an agent that reacts to
  `comment.created` by adding a comment will trigger itself. Filter on the
  author in `match`, or emit only for human-authored changes.

## Seeing an event arrive locally

`pnpm -F hello-mcp-events demo` runs the example with a printing in-process
receiver: it subscribes, calls `add_comment`, and prints the signed delivery
and whether its signature verifies.

To deliver to a real receiver on your machine, the receiver must speak
`https` (subscribe refuses anything else) and the pinned transport must be
told loopback is fine — **development only**, it disables the SSRF guard:

```ts
import {readFileSync} from 'node:fs';
import {createPinnedTransport, installMcpEvents} from '@agentback/mcp-events';

await installMcpEvents(app, {
  transport: createPinnedTransport({
    allowPrivateAddresses: true,
    ca: readFileSync('dev-ca.pem', 'utf8'), // your receiver's self-signed CA
  }),
});
```

When a subscribe answers `-32015`, the server log has the cause (for a
loopback receiver: "refusing to connect to non-public address").

## Testing

Drive the whole loop in process with a stub transport as the receiver — see
[`examples/hello-mcp-events/src/__tests__/app.test.ts`](../../examples/hello-mcp-events/src/__tests__/app.test.ts).
It answers the challenge, records deliveries, and checks each with
`verifyWebhook(secret, headers, body)`. To try it against ChatGPT, run the
example behind an `https` tunnel and follow OpenAI's MCP Events testing
checklist.
