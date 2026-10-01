# @agentback/mcp-events

Webhook delivery for **MCP Events** — the extension that lets an MCP client
subscribe to things happening in your app and have an agent react without the
user present (ChatGPT ships it). `@agentback/mcp` declares event types
(`@event`), answers `events/list|subscribe|unsubscribe`, and holds the
subscriptions; this package is the half that talks to the network: the
endpoint verification handshake and signed, retried, IP-pinned POSTs.

It targets OpenAI's webhook-only subset of the
[WG design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md);
see [docs/proposals/mcp-events.md](../../docs/proposals/mcp-events.md) for the
evaluation and [docs/guides/mcp-events.md](../../docs/guides/mcp-events.md)
for the how-to.

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {installMcpEvents} from '@agentback/mcp-events';

const app = new RestApplication();
app.component(MCPComponent);
app.service(DocEvents); // an @mcpServer class with @event methods
await installMcpEvents(app); // binds MCPBindings.EVENT_DELIVERY
await installMcpHttp(app, {auth}); // webhook subscriptions need a principal
await app.start();

// anywhere in the app:
const events = await app.get(MCPBindings.EVENTS);
await events.emit('comment.created', {document_id, comment_id, url});
```

Without `installMcpEvents`, `events/list` still works and `events/subscribe`
answers `-32014 Unsupported`.

## What a delivery looks like

One event per `POST`, `Content-Type: application/json`:

```
webhook-id: evt_789                       (the eventId; stable across retries)
webhook-timestamp: 1739980800             (fresh on every attempt)
webhook-signature: v1,<base64>            (space-separated pair during rotation)
X-MCP-Subscription-Id: sub_a3f1c8e2…

{"eventId":"evt_789","name":"comment.created","timestamp":"…","data":{…},"cursor":null}
```

Signatures follow [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):
`HMAC-SHA256(secret, id + "." + timestamp + "." + body)` over the exact bytes
sent, keyed by the client-supplied `whsec_` secret. Off-the-shelf verifiers
(Svix's libraries) accept them; `verifyWebhook()` is exported for tests and
for an AgentBack app on the receiving end.

## Exports

| Export                                                  | What                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `installMcpEvents(app, opts)`                           | Binds the delivery port, starts the queue worker; returns `Installed`                                             |
| `WebhookEventDelivery`                                  | The `EventDelivery` implementation: verification handshake, per-host rate limit, enqueue, per-attempt sign + POST |
| `createPinnedTransport(opts)`                           | Node transport that validates the resolved IP **at connect time** and connects to it; no redirects                |
| `fetchTransport(fetch)`                                 | Platform-`fetch` transport for hosts without `node:https` — **cannot pin**                                        |
| `signWebhook`, `verifyWebhook`, `generateWebhookSecret` | Standard Webhooks on Web Crypto                                                                                   |
| `WEBHOOK_DELIVERY_QUEUE`                                | The `@agentback/messaging` queue deliveries ride on                                                               |

### `installMcpEvents` options

| Option                          | Default                                     | Meaning                                                    |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `transport`                     | `createPinnedTransport()`                   | How POSTs leave the process                                |
| `queue`                         | the app's `messaging.JobQueue`, else memory | Bind the BullMQ adapter for retries that survive a restart |
| `timeoutMs`                     | `5000`                                      | Per-attempt timeout                                        |
| `attempts`                      | `4`                                         | Attempts per delivery, first included                      |
| `backoffMs`                     | `30000`                                     | First retry delay, doubling                                |
| `concurrency`                   | `8`                                         | Worker concurrency                                         |
| `verificationsPerHostPerMinute` | `10`                                        | Verification POSTs per destination host                    |

Subscription policy (TTL grants, per-principal cap, rotation grace,
verification cache lifetime) is `MCPServerConfig.events` in `@agentback/mcp`.

## Security model

The callback URL is attacker-supplied by design, so the rules are strict:

- **SSRF: the IP is pinned.** A subscribe-time check is useless against DNS
  rebinding (public when checked, internal when connected to). The pinned
  transport resolves inside the socket's own `lookup`, refuses the connection
  if **any** answer is outside globally reachable space (the IANA
  special-purpose registries, via `isPublicAddress` from `@agentback/common`,
  shared with `mcp-connect`), and connects to the address it just validated.
  SNI, certificate verification and `Host` keep the original name. IP literals
  are checked before connecting, since Node never calls `lookup` for them.
  `fetchTransport` cannot do any of this: on an edge host, restrict egress at
  the platform.
- **No redirects**, on verification or delivery. A 3xx is a failed attempt.
- **Anti-flooding.** HMAC stops forged deliveries; it does not stop someone
  pointing a subscription at a victim's URL. Nothing is delivered until the
  endpoint echoes a single-use challenge in a `2xx` body (constant-time
  compare). Verification is cached per `(principal, url)`, so varying
  `arguments` cannot multiply POSTs at a victim, and it is rate-limited per
  destination host.
- **No oracle.** Failures surface only as a category —
  `connection_refused | timeout | tls_error | http_4xx | http_5xx |
challenge_failed` — never the endpoint's body, headers or status line.
- **Bounded retries.** `2xx` is done; `410` and `413` are final; anything else
  retries with exponential backoff up to `attempts`. Each attempt re-reads the
  subscription, so an unsubscribe, an expiry (`refreshBefore` passing) or a
  revocation stops delivery. Bodies over 256 KiB are never sent.
- **Payloads are untrusted data** for the receiving agent, like tool results:
  send a summary plus the id a read tool takes, never instructions.

## Not built

Poll and push delivery, `gap`/`terminated` envelopes, `deliveryStatus`,
`v1a` (ed25519) signing, and cursor replay (`cursor` is always `null`) — none
is in OpenAI's subset. See the proposal's out-of-scope list.
