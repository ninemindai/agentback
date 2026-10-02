# Plan 007 — MCP Events: `@event` + webhook delivery

**Written against commit:** `08bfeb5`.
**Spec:** [docs/proposals/mcp-events.md](../docs/proposals/mcp-events.md) (E-7,
merged in ninemindai/agentback#63). This plan builds that proposal's §6 order
1–4 in one branch.
**Package(s):** `@agentback/common` (address classifier),
`@agentback/mcp` (registration, handlers, ports), new
`@agentback/mcp-events` (webhook delivery), `@agentback/mcp-connect`
(consumes the hoisted classifier), `examples/hello-mcp-events`.
**Status:** BUILT, reviewed (/autoplan, all findings below applied or
deferred). ChatGPT acceptance (proposal §6.4) is a manual step still open —
see TODOS.md.

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

## Review record — /autoplan, 2026-10-01

Run against the built branch (plan + diff vs `origin/main`). Phases: CEO
(SELECTIVE EXPANSION), DX (developer-facing scope), Eng; Design skipped (no UI
scope). Each phase ran as an independent in-host reviewer reading the full
review methodology; the outside voice (Codex) was **unavailable** (not
installed), so no dimension is cross-model CONFIRMED. Full reports, the Eng
test plan, and the restore point are under
`~/.gstack/projects/ninemindai-agentback/` on the build machine.

**Bugs the review found, all confirmed by a probe and fixed here:**

1. **Nothing delivered on BullMQ** (CEO + Eng): the job id was
   `${subId}:${eventId}`; BullMQ 6 throws `Custom Id cannot contain :`, the
   emitter swallowed it. Now a colon-free hash (`deliveryJobId`).
2. **Unbounded retention** (CEO + Eng): no `removeOnComplete`, so the
   in-memory queue kept every body (2000 deliveries → ~20 MB) and rescanned
   them each tick. Now removed on completion and on final failure.
3. **Cap and verification race** (Eng): 20 concurrent subscribes passed a cap
   of 3 and sent 20 challenge POSTs. Now one shared handshake per
   `(principal, url)` and a per-principal lock over check + write.
4. **OAuth users pooled under the client app** (all three phases): with no
   `extra.user`, the principal fell back to `clientId`. Now `extra.user` else
   `extra.sub`, else `-32012`.
5. **`localPrincipal` for anonymous HTTP callers** (DX + Eng): now off-HTTP
   only.

### Accepted amendments (applied in this branch)

<!-- autoplan-accepted:ceo -->

- Colon-free hashed delivery job id; test asserts no `:` and stability.
- `removeOnComplete`/`removeOnFail: true`; test asserts the queue is empty after 20 deliveries; guide no longer calls single-process defaults "correct" for multi-instance.
- Per-user principal: `extra.user` → `extra.sub` → `-32012`; tests for clientId-only refusal and per-`sub` isolation.
- Verification budget per principal, failures per host; `events.trustedCallbackOrigins` allowlist; tests (50 principals on one host succeed; 10 failures lock the host; trusted origin sends no POST).
- `fetchTransport` refuses non-public IP literals and `localhost` (subscribe-level refusal rejected: it would remove the dev escape hatch the pinned transport offers).
- Portable subscription record: `profile` (JSON claims) replaces `user`; JSON round-trip test.
- `emit` refuses an occurrence over 256 KiB (`MAX_EVENT_BYTES`); `deliver` throws instead of silently dropping.
- Subscribe authorization maps only a denial to `-32012`; a failing voter is an internal error (test).
- `onDeliveryResult` hook + error log on the final attempt (test).
- 3xx is a final failure (test). `eventId` validated at emit (test). Fan-out bounded (32) with the binding key resolved once. `cursor: string | null`, `truncated: boolean`.
- Subscribe to an event only a per-session binder declares answers `-32014 {feature:'event'}` (test).
- Docs: revocation latency and request-less voter context; `mcp-connect` README notes the widened classifier.

<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->

- Server-side cause logged on a failed verification, with the local-dev hint; terse wire error unchanged.
- Local receiver path documented (guide, package README `createPinnedTransport` table, skill, example README).
- `pnpm -F hello-mcp-events demo` prints a signed delivery and its verification result.
- Unknown-event emit error lists the emittable events and the app-level binding rule; per-session caveat documented.
- `MCPServerConfig.events` placement and defaults table in the guide.
- README snippet fixes (`MCPBindings` import, payload fields), `listEvents()` documented.
- One-time operator warnings for `-32014` (no delivery bound) and `-32012` (anonymous / no subject).
- `EmitReport.delivered` renamed `queued` (unreleased).
- Experimental label on every events surface.
- Config errors include the offending values (test).
- Skill reference: paste-ready stub-receiver test and the `EventBus` disambiguation.

<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->

- Bugs 1–3 above, with the tests named there.
- TTL capped at the token's `expiresAt` (test).
- `ca` added to Node's public roots instead of replacing them.
- Callback URL normalized to `url.href` (test: mixed-case host + `:443` is one subscription).
- In-memory verification map pruned past 10 000 entries.
- Install test: no attempts after `uninstall()`.
- Doc fix: a revocation stops retries only once a later emit deletes the subscription.

<!-- /autoplan-accepted:eng -->

### Decision audit trail

| #   | Phase | Decision                                                 | Classification | Principle | Rationale                                                                                            | Rejected                                |
| --- | ----- | -------------------------------------------------------- | -------------- | --------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | 0     | Skip /office-hours                                       | Mechanical     | P6        | The merged proposal is the design doc                                                                | Running office-hours                    |
| 2   | CEO   | Principal = `extra.user` → `extra.sub`, never `clientId` | Taste          | P1        | Matches the repo's own guidance in `installMcpHttp` (`perSession` example); spec demands a principal | Documenting shared-principal semantics  |
| 3   | DX    | `localPrincipal` only off HTTP                           | Taste          | P1        | Spec: identity must be unguessable; an anonymous network caller is not the local operator            | Keep, document                          |
| 4   | Eng   | Per-host in-flight delivery cap                          | Taste          | P3        | **Rejected**: ChatGPT uses one receiver host for all users; deferred to failure-rate suspension      | (adopted instead: TODO)                 |
| 5   | Eng   | In-memory queue rejects colon ids (BullMQ parity)        | Taste          | P5        | **Deferred**: `DefaultScheduler` already uses 3-part colon ids; adapter-level error TODO instead     | Changing messaging semantics in this PR |
| 6   | CEO   | Subscribe-level refusal of private literals              | Taste          | P3        | **Rejected** at subscribe (kills the dev escape hatch); applied in `fetchTransport` instead          | —                                       |
| 7   | CEO   | Exported store conformance suite + Redis store           | User Challenge | —         | Proposal §3.4 deferred it; not auto-decided — TODO flagged for the user                              | —                                       |
| 8   | CEO   | ChatGPT acceptance (§6.4)                                | Mechanical     | P1        | Cannot run here (no account; egress blocks OpenAI's docs); status says so; TODO                      | Marking DONE                            |
| 9   | DX    | Rename `delivered` → `queued`                            | Taste          | P5        | Unreleased; the old name overstated what happened                                                    | Keep the name, reword docs              |
| 10  | DX    | `defineEvent`, stub-receiver helper, metrics             | Taste          | P3        | Outside this change's blast radius; TODOs                                                            | Building now                            |

### Phase coverage

| Phase  | Ran | Native (in-host) | Outside (Codex) | Findings applied / deferred |
| ------ | --- | ---------------- | --------------- | --------------------------- |
| CEO    | yes | completed        | unavailable     | 15 / 3 (+1 user challenge)  |
| Design | no  | skipped (no UI)  | skipped         | —                           |
| DX     | yes | completed        | unavailable     | 13 / 3 (+1 decided above)   |
| Eng    | yes | completed        | unavailable     | 13 / 2                      |
