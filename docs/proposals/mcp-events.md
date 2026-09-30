# Proposal: MCP Events — `@event` and webhook delivery

**Status:** **Draft — evaluation only, nothing built.** Filed 2026-09-30.

**Sources evaluated:**

- OpenAI, [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
  — ChatGPT's shipped integration.
- MCP Triggers & Events WG,
  [design sketch](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md)
  — draft proposal, single author, dated 2026-02-19 (repo last pushed
  2026-09-08).

**Recommendation:** build it, but target **OpenAI's webhook-only subset**, not
the full sketch. Shape the registration so poll/stream can be added later
without a breaking change.

---

## 1. What the extension is

A server declares event types; a client subscribes with `(name, arguments)`;
occurrences `{eventId, name, timestamp, data, cursor}` reach the client without
the user present, and the agent reacts (e.g. "watch #product-feedback and open
draft PRs for bug reports").

| Surface   | Sketch                                                                                    | OpenAI (ChatGPT)                          |
| --------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| Protocol  | Extension; capability `events`                                                            | Requires `2026-07-28`; top-level `events` |
| Discovery | `events/list` (paginated, `listChanged`)                                                  | `events/list`                             |
| Delivery  | **poll** (`events/poll`), **push** (`events/stream`), **webhook** (`events/subscribe`)    | **webhook only**                          |
| Control   | `gap`, `terminated` envelopes; `deliveryStatus` on refresh                                | none of these                             |
| Signing   | Standard Webhooks profile, client-supplied `whsec_` secret (24–64 B), multi-sig rotation  | same                                      |
| Endpoint  | Mandatory proof of intent (challenge, allowlist, well-known, or out-of-band)              | challenge handshake                       |
| Identity  | `(principal, delivery.url, name, arguments)`; server-derived `id` for routing only        | same, args compared as canonical JSON     |
| TTL       | client suggests `ttlMs`, server grants `refreshBefore` (≤ suggestion; `null` = no expiry) | same                                      |
| Replay    | opaque cursor, `truncated: true` on gaps, `maxAgeMs` floor                                | cursor supported; `null` = no replay      |
| Limits    | body ≤ 256 KiB; `413` non-retryable                                                       | 256 KiB; no retry on `410`/`413`          |
| Errors    | `-32602`, `-32011`…`-32015` (general-purpose, typed `data`)                               | cites `-32015 CallbackEndpointError`      |

### What the sketch gets right

- **It separates deception from flooding.** HMAC over a client-supplied secret
  stops forged deliveries (_deception_). It does not stop an attacker from
  pointing a subscription at a victim's URL (_flooding_). Mandatory endpoint
  verification, cached per `(principal, url)`, closes that gap and caps
  attacker-induced traffic at one POST per victim URL.
- **The identity tuple is the subscription.** No client-generated id, so
  subscribe is naturally idempotent and refresh is just subscribing again. The
  client holds the canonical list; with short granted TTLs the server can keep
  soft in-memory state and a crash never orphans anyone.
- **Payloads are untrusted data**, with the same injection stance as tool
  results. The guidance is to send a summary plus a read tool for large
  records, and never to put model instructions in `data`.

### Where it is weak

Three delivery modes is roughly 3× the spec and SDK surface. The sketch says
so itself ("goes against MCP's usual stance"). The first large host to adopt it
shipped webhook alone. Expect churn in the error codes and control envelopes
before this reaches the base spec. That is another reason to track OpenAI's
subset, which skips both.

---

## 2. Feasibility — the SDK is not a blocker (measured)

Probed against `@modelcontextprotocol/server@2.1.0` via `createMcpHandler` (the
handler behind `mcp-http`'s default `protocol: 'both'`):

- `new McpServer(info, {capabilities: {tools: {}, events: {}}})` returned
  `capabilities: {tools: {listChanged: true}, events: {}}` from
  `server/discover`.
- A custom `events/list` registered with the 3-argument
  `server.setRequestHandler(method, {params, result}, handler)` answered over
  the `2026-07-28` wire with `resultType: 'complete'`.

**One tension to pin with a test:** the SDK's `ServerCapabilitiesSchema` is a
strict `z.object` whose intended slot for extensions is
`extensions: Record<string, object>`. OpenAI's page wants `events` at the top
level. It survives today only because the SDK does not parse its own outgoing
capabilities. If that ever changes, the key is silently stripped and ChatGPT
stops seeing events with no error anywhere.

---

## 3. Design sketch for AgentBack

### 3.1 Registration — same shape as `@tool`

An event definition is a name plus two Zod schemas, which is what `@tool`
already is. It projects the same way:

```ts
const CommentFilter = z.object({document_id: z.string()});
const CommentCreated = z.object({
  document_id: z.string(),
  comment_id: z.string(),
  text: z.string(),
  url: z.string().url(),
});

@mcpServer()
class DocEvents {
  @event('comment.created', {
    description: 'A new review comment was added to the specified document.',
    input: CommentFilter, // → inputSchema (subscription arguments)
    payload: CommentCreated, // → payloadSchema (the `data` object)
    scope: 'docs:read', // visibility gate, as on @tool
  })
  matches(
    args: z.infer<typeof CommentFilter>,
    e: z.infer<typeof CommentCreated>,
  ) {
    return e.document_id === args.document_id; // the sketch's `match` hook
  }
}
```

- `inputSchema`/`payloadSchema` come from the same `z.toJSONSchema` path as
  `@tool`, including the object-root rule for `input`.
- `payload` is validated **at emit time**, the way `output:` is on `@tool`, so
  "`data` must match `payloadSchema`" holds by construction rather than by
  discipline.
- The decorated method is the sketch's `match(args, event)` hook: it filters on
  the server before delivery, which the OpenAI guide requires.
- Emitting is a port call, e.g.
  `@inject(MCPBindings.EVENTS) events: EventEmitter` →
  `events.emit('comment.created', data, {eventId})`. The fan-out runs `match`
  per active subscription.
- `events/list` must "return only events the connected account is allowed to
  discover". That is the scope filtering `@tool({scope})` already has.

### 3.2 Where state lives — the two stateless invariants apply verbatim

Under `protocol: 'both'` a fresh `MCPServer` is built **per request**. Both bugs
fixed after 0.9.0 (see `CLAUDE.md`) recur here unless designed out:

1. **Nothing subscription-shaped may live on the server instance.**
   Subscriptions, the `(principal, url)` verification cache, and the emit
   fan-out need app-level bindings: a `MCPBindings.SUBSCRIPTION_STORE` port with
   an in-memory default bound by `MCPComponent`, exactly as
   `CONFIRMATION_STORE` is. An instance-level store vanishes between
   `events/subscribe` and the first delivery, which is the `confirm:` bug again.
2. **Anonymous-but-auth-configured callers pass `[]` scopes, never
   `undefined`.** Otherwise scoped events appear in `events/list`. Webhook
   mode additionally **requires** an authenticated principal (the identity
   tuple is only unguessable if the principal is in it), so `events/subscribe`
   from an anonymous caller is a `-32012 Forbidden`.

Handlers register inside `registerAllOn`, alongside `tools/*`, so the
per-request `perRequestFactory` path and the long-lived stdio/session path
share one code path.

### 3.3 Delivery — what is reused vs. built

**Reused:**

| Need               | Existing piece                                                                      |
| ------------------ | ----------------------------------------------------------------------------------- |
| Outbound HTTP seam | `CoreBindings.FETCH` (tests bind a stub, no network)                                |
| Emit source        | `@agentback/messaging` `EventBus` (bridge a topic to an event type)                 |
| Durable cursor     | `actors` journal `seq` (Redis-durable); see caveat below                            |
| Retry + backoff    | `JobQueue` semantics; a delivery attempt is a job with `attempts` and a `timeoutMs` |
| Visibility         | `@tool({scope})` filtering path                                                     |
| Revertible install | the `Installed` contract, `installSteps`, and `runInstallConformance`               |

Caveat on the actors cursor: `registry.events(type, id)` returns the **whole**
per-identity log. An "after `seq`" read would have to filter client-side, so a
`since` parameter on the reader is a small prerequisite for efficient replay.

**Built new:**

1. **A fetch that pins the resolved IP. This is the one real security
   primitive.** OpenAI requires resolving the destination at connection time,
   connecting to the validated address, keeping the original hostname for
   TLS, and refusing redirects, for both verification and delivery.
   `mcp-connect/src/ssrf.ts` checks at validation time only, and its own doc
   comment says DNS rebinding and redirects are not covered. The build is an
   undici `Agent({connect: {lookup}})` whose `lookup` rejects non-public
   addresses (reuse `isBlockedAddress`, and widen it toward the IANA
   special-purpose registries the sketch cites), plus `redirect: 'error'`.
   Hoist the address classifier into `@agentback/common` so `mcp-connect` and
   `mcp-events` share one implementation.
2. **Standard Webhooks signing**: `HMAC-SHA256(secret, id.ts.body)`,
   base64 `v1,` signatures, and space-separated dual signatures during
   rotation. Either the `standardwebhooks` package or about 30 lines on
   `node:crypto`. Prefer our own code: it is small, it must run on the edge
   host (Web Crypto), and serializing the body **once** and signing those
   exact bytes is the invariant that matters.
3. **Verification handshake**: a single-use short-lived nonce with a unique
   `webhook-id`, a signed POST, a `2xx` requirement, a constant-time echo
   compare, and a bounded cache keyed on `(principal, url)`. Failure →
   `-32015` with `data.reason ∈ {connection_refused, timeout, tls_error,
http_4xx, http_5xx, challenge_failed}`.
4. **Subscribe validation**: `https` only, a `whsec_` secret decoding to
   24–64 bytes (else `-32602`), args validated against `input`, canonical-JSON
   identity, a deterministic `id`, and the TTL grant (≤ `ttlMs`, clamped up to
   a server minimum; `refreshBefore: null` only when `ttlMs: null` was asked
   for **and** granted).
5. **Delivery policy**: one event per POST, a 256 KiB cap checked before
   sending, the same `eventId` on every retry with a fresh timestamp and
   signature per attempt, no retry on `410`/`413`, and expiry enforcement
   (stop delivering once `refreshBefore` passes).
6. **Revocation**: re-check the principal's access during the subscription's
   lifetime and stop delivery if it is revoked. This needs a hook into
   whatever authorizes the principal; `@authorize` voters are the natural
   place.

### 3.4 Package layout

- **`@agentback/mcp`**: `@event`, `ToolMetadata`'s sibling `EventMetadata`,
  the `events/list|subscribe|unsubscribe` handlers, the `SUBSCRIPTION_STORE`
  and `EventEmitter` ports, and the in-memory defaults. No network code, so
  `mcp` stays host-neutral.
- **`@agentback/mcp-events`** (new): webhook delivery. The IP-pinning fetch
  (Node host only; the edge host delivers through the platform `fetch` and
  documents that it cannot pin), signing, the verification handshake, the
  retry policy, and an `installMcpEvents(app)` that returns `Installed`.
  This mirrors why `mcp-http` is separate from `mcp`.
- A Redis-backed `SubscriptionStore` can follow in `messaging-bullmq` or
  `actors-redis` when a multi-instance deployment needs it. Until then, short
  granted TTLs make the in-memory default correct, which is the sketch's own
  soft-state argument.

---

## 4. Explicitly out of scope (for this proposal)

- **Poll and push modes.** They would slot in behind the same `@event`
  registration later. The sketch's "one `check(cursor)` backs every mode"
  design is compatible with the emit-first shape above.
- **`gap` / `terminated` control envelopes, `deliveryStatus`, asymmetric `v1a`
  signing.** None of these is in OpenAI's subset.
- **`mcp-host` aggregating upstream servers' events.** Namespacing and
  per-upstream subscription proxying is its own design.
- **AgentBack as a _receiver_**: an `agents` turn triggered by an upstream MCP
  server's events. That is the client side (callback endpoint, signature
  verification, per-event agent turn with `withModelScope`) and arguably the
  more interesting product story, but it is a separate proposal.

---

## 5. Risks

| Risk                                        | Mitigation                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| Sketch churn (codes, envelopes, capability) | Track OpenAI's subset; keep the wire mapping in one module                              |
| SDK strips top-level `events` capability    | A test asserting `server/discover` carries `capabilities.events`                        |
| SSRF via DNS rebinding / redirects          | Pin the resolved IP per connection; `redirect: 'error'`; shared address classifier      |
| Subscription state lost per request         | App-level `SUBSCRIPTION_STORE`; a test that subscribes and delivers across two requests |
| Scoped events leak to anonymous callers     | `[]`-not-`undefined` scopes; webhook requires a principal                               |
| Feedback loops (agent edits → new event)    | Documented in the guide; out of the server's control, as OpenAI's test list notes       |
| Edge host cannot pin IPs                    | Deliver from the Node host only, or document the platform `fetch` limitation explicitly |

---

## 6. Suggested order

1. `@event` + `events/list` in `@agentback/mcp`, with scope filtering and the
   capability test. Visible in ChatGPT's plugin page with zero delivery code.
2. `SUBSCRIPTION_STORE` + `events/subscribe`/`unsubscribe` validation and
   identity, without delivery (verification stubbed behind the port).
3. `@agentback/mcp-events`: IP-pinning fetch → signing → verification →
   delivery and retries, each with the security tests from OpenAI's checklist
   (invalid signatures, duplicate deliveries, revoked access, refresh across
   restart).
4. An `examples/hello-mcp-events` app, driven end to end against ChatGPT per
   OpenAI's "Test in ChatGPT" list, plus the doc surfaces listed in
   `CLAUDE.md`.
