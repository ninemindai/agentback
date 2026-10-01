# Plan 007 — MCP Events: `@event` + webhook delivery

**Written against commit:** `08bfeb5`.
**Spec:** [docs/proposals/mcp-events.md](../docs/proposals/mcp-events.md) (E-7,
merged in ninemindai/agentback#63). This plan builds that proposal's §6 order
1–4 in one branch.
**Package(s):** `@agentback/common` (address classifier),
`@agentback/mcp` (registration, handlers, ports), new
`@agentback/mcp-events` (webhook delivery), `@agentback/mcp-connect`
(consumes the hoisted classifier), `examples/hello-mcp-events`.
**Status:** IN PROGRESS.

---

## Wire contract (OpenAI's webhook-only subset of the WG sketch)

| Surface              | Built                                                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capability           | top-level `capabilities.events: {}`, advertised only when at least one `@event` is discovered when a server is built                                                                                             |
| `events/list`        | `{events: [{name, title?, description?, delivery: ['webhook'], inputSchema, payloadSchema}]}` filtered by the caller's scopes exactly like `tools/list`                                                          |
| `events/subscribe`   | `{name, arguments?, delivery: {mode?: 'webhook', url, secret}, ttlMs?, cursor?, maxAgeMs?}` → `{id, refreshBefore, cursor: null, truncated: false}`                                                              |
| `events/unsubscribe` | `{name, arguments?, delivery: {url}}` → `{}`                                                                                                                                                                     |
| Delivery             | one POST per event, body `{eventId, name, timestamp, data, cursor: null}`; headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<b64>`, space-separated during rotation), `X-MCP-Subscription-Id` |
| Verification         | signed `{"type":"verification","challenge":<nonce>}`; endpoint must answer 2xx with `{"challenge":<nonce>}` (constant-time compare); cached per `(principal, url)`                                               |
| Errors               | `-32602` invalid params, `-32011` NotFound `{kind}`, `-32012` Forbidden, `-32013` ResourceExhausted `{limit, max}`, `-32014` Unsupported `{feature, value}`, `-32015` CallbackEndpointError `{reason}`           |

Out of scope, per the proposal §4: poll/push, `gap`/`terminated` envelopes,
`deliveryStatus`, `v1a` signing, replay (`cursor` is always `null`),
`mcp-host` aggregation, AgentBack as a receiver.

## Steps

1. **`@agentback/common`: shared address classifier.** `isBlockedAddress(ip)`
   / `isPublicAddress(ip)`, pure (no `node:net`, so it loads on every host),
   widened toward the IANA IPv4/IPv6 special-purpose registries (TEST-NETs,
   benchmarking, 6to4/NAT64/Teredo embedded IPv4, multicast, documentation,
   discard-only, reserved). `mcp-connect/src/ssrf.ts` imports it.
2. **`@agentback/mcp`: `@event` + `events/list` + capability.**
   - `@event(name, {description, title, input?, payload, scope?})` on
     `@mcpServer` classes; the method is the `match(args, data)` filter.
   - `EventMetadata` beside `ToolMetadata`; `compileEvent` memoized like
     `compileTool` with the same object-root rule for `input` **and**
     `payload` (`data` is an object on the wire).
   - Duplicate event names throw at `start()`; root-nearest wins after.
   - Handlers register inside `registerAllOn` so stdio, sessions and the
     per-request stateless factory share one path; the `scopes` argument they
     receive already carries the `[]`-for-anonymous invariant.
   - Test: `capabilities.events` survives on `initialize` and on
     `server/discover` (2026-07-28), so an SDK change that strips it fails CI.
3. **`@agentback/mcp`: subscriptions, without delivery.**
   - Ports: `SubscriptionStore` (+ `InMemorySubscriptionStore`, bound
     app-level by `MCPComponent` at `MCPBindings.SUBSCRIPTION_STORE`, exactly
     like `CONFIRMATION_STORE`), `EventDelivery` (bound by
     `@agentback/mcp-events`; absent ⇒ subscribe answers `-32014`), and
     `McpEventEmitter` at `MCPBindings.EVENTS`.
   - Validation: authenticated principal (`localPrincipal` counts) else
     `-32012`; hidden or unknown event ⇒ `-32011 {kind:'event'}`; `@authorize`
     voters ⇒ `-32012`; `https` only; `whsec_` secret decoding to 24–64 bytes;
     arguments validated against `input`; `ttlMs` a non-negative integer or
     `null`.
   - Identity: `(principal, url, name, canonical-JSON(arguments))`, `id =
sub_` + truncated SHA-256 (Web Crypto, so it runs on the edge host).
   - TTL grant: omitted ⇒ default (1 h); number ⇒ clamped to `[min, max]`
     (60 s, 24 h); `null` ⇒ `null` only when `events.allowNoExpiry` is set
     (the in-memory store cannot honour no-expiry across a restart, so it is
     off by default).
   - Secret rotation: a refresh with a new secret keeps the old one for
     `secretRotationGraceMs` (5 min) and deliveries dual-sign.
   - Per-principal cap (`maxSubscriptionsPerPrincipal`, 100) ⇒ `-32013`.
   - Emit: `emit(name, data, {eventId?, timestamp?})` validates `data`
     against `payload` (throws), then for each live subscription re-checks
     access (revocation), runs `match`, and hands the occurrence to
     `EventDelivery`. A subscription whose access is revoked is deleted.
4. **`@agentback/mcp-events`: webhook delivery.**
   - `createPinnedTransport()` (Node): `node:https` with a `lookup` that
     resolves, rejects any non-public address, and connects to the address it
     validated; SNI and `Host` keep the original name; redirects are never
     followed (a 3xx is a failed attempt). `fetchTransport(fetch)` for the
     edge host, documented as unpinned.
   - Standard Webhooks signing and verification on Web Crypto; the body is
     serialized once and those bytes are signed and sent.
   - `WebhookEventDelivery`: verification handshake (nonce, signed POST, 2xx,
     constant-time echo, per-host rate limit), and delivery as a
     `@agentback/messaging` `JobQueue` job (`jobId = subId:eventId` dedups a
     re-emit; `attempts` + exponential `backoff`); each attempt re-reads the
     subscription (stops after unsubscribe, expiry, revocation), signs with a
     fresh timestamp, and treats `410`/`413` as final. 256 KiB cap checked
     before enqueue.
   - `installMcpEvents(app, opts)` returns `Installed` (`installSteps`), with a
     `runInstallConformance` test.
5. **`examples/hello-mcp-events`** and the doc surfaces CLAUDE.md lists
   (package READMEs, `docs/packages.md`, a guide, `docs/README.md`, the
   agent skill + reference, CLAUDE.md, the proposal status).

## Verification

`pnpm verify` (konsistent, check:generated, lint, build, typecheck:client,
test, validate-templates, build:site).
