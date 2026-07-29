# Proposal: adopt MCP protocol revision `2026-07-28` (stateless core)

**Status:** **DESIGN** (2026-07-29). Phase 1 — the SDK v1→v2 package swap with
zero wire change — shipped in `0.8.0` (`910966a`, `c9862e8`, `d59a1ac`). This
document is Phase 2: putting `2026-07-28` bytes on the wire.

**Nothing here is on a deadline.** SDK v2 speaks the 2025 era by default, the
2025 era has a 12-month deprecation window, and v1 gets security fixes for ~6
months from 2026-07-28. This is a "do it deliberately" change, not a scramble.

**Everything below is verified against `@modelcontextprotocol/server@2.0.0`'s
emitted types and against a measurement in this repo**, not inferred from the
announcement. Where something is still unverified it says so.

---

## 1. What the revision actually changes

| Axis                   | 2025 era                                      | `2026-07-28`                                                     |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| Server HTTP entry      | `*StreamableHTTPServerTransport`              | `createMcpHandler` (also serves 2025 when `legacy: 'stateless'`) |
| Server stdio entry     | `server.connect(new StdioServerTransport())`  | `serveStdio(factory)`                                            |
| Handshake              | `initialize` / `initialized`                  | none — `server/discover`, per-request `_meta` envelope           |
| Session                | `Mcp-Session-Id` header                       | **gone**                                                         |
| Client identity        | `getClientCapabilities()` (initialize-scoped) | `ctx.mcpReq.envelope` (per request)                              |
| Server→client requests | `elicitInput` / `requestSampling`             | `return inputRequired(...)` (MRTR)                               |
| Change notifications   | unsolicited `list_changed`                    | `subscriptions/listen` stream                                    |
| Cancellation           | POST `notifications/cancelled`                | close the request's SSE stream                                   |

Deprecated with a 12-month window, **not removed**: roots, sampling, logging,
and Dynamic Client Registration (→ CIMD). AgentBack uses **none** of these in
framework code, so they cost us nothing.

`notifications/progress` is **not** deprecated — a `progressToken` still rides
the originating request's own stream. `MCPBindings.PROGRESS` and the `streamOf`
generator path survive unchanged. (This was raised as a risk in the Phase 1
review's outside voice; it checks out clean.)

---

## 2. The load-bearing seam: `McpServerFactory`

```ts
type McpServerFactory =
  (ctx: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>;

interface McpRequestContext {
  era: 'legacy' | 'modern';
  authInfo?: AuthInfo;   // pass-through; the SDK NEVER verifies tokens itself
  requestInfo?: Request; // the original Web Request
}

createMcpHandler(factory, {legacy}) -> {fetch, close, notify, bus}
handler.fetch(request, {authInfo, parsedBody})
```

Two consequences worth stating plainly:

**Auth stays ours.** `authInfo` is _strictly pass-through_ — the handler
performs no token verification. So the Phase 1 bearer guard
(`requireBearerAuth` from `/server` on the fetch host, `/express` on the Node
host) keeps its exact role: verify, then hand the result to `fetch()`. Nothing
about the auth stack changes in Phase 2.

**`buildServer()` was already the right shape.** `MCPServer.buildServer()`
exists today because "a single `McpServer` can only be connected to one live
transport at a time" — it mints a fresh instance per session. The factory needs
exactly that, per request. The architecture anticipated this.

---

## 3. `perSession` → per-request discovery (NOT `requestState`)

This is the correction that most changes the shape of the work, and it reverses
an earlier assumption of ours.

`requestState` is **not** the destination. It only round-trips during a
multi-round-trip exchange, _after_ the server has already answered
`resultType: "input_required"`. It is absent on a first call — which is
precisely when tool visibility must be decided. It is also client-echoed
untrusted input: `createRequestStateCodec` gives integrity, not authority (no
replay defense, no revocation, no staleness). It is for MRTR flow-state, full
stop.

The real destination is the factory, which already carries the validated
principal:

```
TODAY (per session)                    PHASE 2 (per request)
─────────────────────────              ──────────────────────────────
POST /mcp (initialize)                 POST /mcp
  └─ guard: verify bearer                └─ guard: verify bearer -> authInfo
  └─ perSession(sessionCtx, req)         └─ handler.fetch(req, {authInfo})
  └─ sessionCtx.get(MCPServer)                └─ factory({era, authInfo, req})
  └─ buildServer({scopes})                        └─ perRequest(reqCtx, authInfo)
  └─ transport.connect()                          └─ reqCtx.get(MCPServer)
       │                                          └─ buildServer({scopes})
       │  (reused for every later
       │   request on this session)
```

`perSession(ctx, req)` becomes `perRequest(ctx, authInfo, request)`. Same binder
contract, same DI child context, and it gets a **typed, validated** principal
instead of today's `(req as Request & {auth?: AuthInfo}).auth` cast — a small
security improvement, since the binder can no longer accidentally key off a
spoofable header.

**Shipped (S2), and it fixed a live bug.** The binder now takes a Web `Request`
on _both_ hosts and reads the principal from the DI context it is handed
(`MCPBindings.REQUEST_AUTH`), through one shared `resolveSessionServer` seam.

Before this, each mount had its own copy of the session-context construction and
they disagreed about the binder's second argument: the Express mount passed an
Express `req` while the fetch mount passed a Web `Request` behind a
`as unknown as` cast, and the exported `SessionBinder` type claimed the Express
shape. The documented example read `req.auth` — which does not exist on a Web
`Request` — so a binder written to the published signature silently broke on the
edge host. `perSession` had **zero** fetch-host coverage, which is why it
survived. Both hosts are now covered by the same parity tests.

Reading identity from the context rather than the request is also the shape S4
needs: the factory hands over `{authInfo, requestInfo}`, which bind into the
child context exactly the same way.

**Session-pinning disappears, correctly.** `ownsSession` exists today because a
session id outlives the request that created it and must never serve another
tenant. With no session, every request re-authenticates and the whole class of
bug goes away. This is a net reduction in security surface, not a new risk.

---

## 4. The performance problem, measured

Per-request server construction is the one thing that can quietly ruin this.
Measured in this repo (`buildServer()`, warm, 50 iterations):

| tools | per call | implied single-core ceiling |
| ----- | -------- | --------------------------- |
| 10    | 0.34 ms  | ~2900 req/s                 |
| 25    | 1.15 ms  | ~870 req/s                  |
| 50    | 2.04 ms  | ~490 req/s                  |
| 100   | 6.04 ms  | ~166 req/s                  |

Today this is paid **once per session**. Under `createMcpHandler` it is paid
**on every request**. At 100 tools that is ~6 ms of CPU before any actual work,
which undercuts the exact promise (scale behind a plain round-robin LB) that
motivates the stateless revision.

The cost is dominated by eager JSON Schema emission — `registerAllOn` calls
`schemaToOpenApiSchema` for every tool's `input` and `output`
(`mcp.server.ts:794-800`, eager _by design_ so a non-describable schema fails
at startup rather than at `tools/list`).

**The fix: split invariant from per-request.**

```
                        computed ONCE (app start)        per REQUEST
                        ─────────────────────────        ───────────
tool discovery          ctx.find(extensionFilter)   ->   (reuse)
JSON Schema emission    schemaToOpenApiSchema       ->   (reuse)
ToolListEntry build     name/desc/_meta/ui          ->   (reuse)
─────────────────────────────────────────────────────────────────────
visibility filter                                        array filter on scopes
handler binding                                          closure over reqCtx
```

Everything expensive is deterministic per tool and does not vary by caller.
Only visibility (scopes/entitlements) and the DI context are per-request, and
both are cheap.

**Shipped.** Compilation is memoized per `(class, method)` in a module-level
`WeakMap` — module-level and not an instance field precisely because every
session (and, later, every request) resolves its own `MCPServer`, so an instance
cache would miss the case that matters. Measured after:

| tools | before  | after       | speedup |
| ----- | ------- | ----------- | ------- |
| 1     | 0.082ms | 0.022ms     | 3.7x    |
| 10    | 0.342ms | 0.034ms     | 10x     |
| 25    | 1.145ms | 0.053ms     | 22x     |
| 50    | 2.044ms | 0.054ms     | 38x     |
| 100   | 6.036ms | **0.096ms** | **63x** |

Cost is now near-flat in tool count rather than superlinear, and the implied
single-core construction ceiling at 100 tools goes from ~166 req/s to
~10,400 req/s. The guard in CI is `tool-compile-cache.unit.ts`, which asserts
the cache by counting a schema's own emissions — deterministic, where a timing
assertion would be flaky on shared runners.

**This is a `@agentback/mcp` change, and it is independently useful** — it makes
today's per-session path faster too. It should land _before_ the transport
work, as its own commit with the benchmark kept as a regression guard.

> Make the change easy, then make the easy change. Memoizing schema emission is
> a refactor with no behavior change; the transport swap is the behavior change.
> Doing them in one commit would make an eventual bisect useless.

---

## 5. What gets deleted

`createMcpHandler` is web-standards-only, with `toNodeHandler` for Express. The
two hosts AgentBack maintains today **converge**:

```
TODAY                                    PHASE 2
─────────────────────────────────        ────────────────────────────
mountMcpHttp (Express, ~500 LoC)   ┐
  transports{} / sessionOwners{}   │
  onsessioninitialized             ├──>  one createMcpHandler(factory)
  GET (SSE) + DELETE routes        │       ├─ express: toNodeHandler(h)
  isInitializeRequest gating       │       └─ edge:    h.fetch
  perSession child ctx             │
mountMcpHttpFetch (edge, ~370 LoC) ┘     PLUS serveStdio(factory) for stdio
```

Removed: the `transports` / `sessionOwners` / `sessionContexts` maps,
`ownsSession`, `onsessioninitialized`, the GET and DELETE handlers,
`isInitializeRequest` gating, and the duplicated Express/fetch mount logic.

**`@agentback/mcp-http` should get smaller.** If it doesn't, the design is wrong.

`InMemoryEventStore` and resumable SSE (`Last-Event-ID` replay) have no place in
the modern era — resumption was a _session_ feature. The replacement for
unsolicited notifications is the `subscriptions/listen` stream, published via
`handler.notify` / `handler.bus`. `InMemoryEventStore` must stay exported while
the legacy path is served.

---

## 6. Open decisions

**D1 — Do the two eras share one endpoint?** `legacy: 'stateless'` serves both
from one `/mcp`. The risk (raised by the Phase 1 outside voice) is `tools/list`
split-brain: a legacy client could see a session-scoped list and a modern client
a per-request one, for the same principal. **Recommendation: yes, one endpoint,
and make discovery per-request on both paths** so the two eras cannot disagree.
That falls out of §3 anyway — once `perRequest` replaces `perSession`, the
legacy stateless path uses the same factory.

**D2 — Does `perSession` stay as a deprecated alias?** It is shipped public API
with a documented security contract. **Recommendation: keep it for one minor,
adapting it to `perRequest` with a deprecation warning**, since the binder body
is usually reusable verbatim.

**D3 — Caching entitlement lookups.** `perSession` is documented as "keep it
cheap, or cache keyed on the authenticated principal." Under per-request that
advice becomes mandatory. **Recommendation: ship a small principal-keyed TTL
cache in the framework** rather than leaving every app to rediscover it.

**D4 — stdio.** `serveStdio(factory)` replaces
`server.connect(new StdioServerTransport())` and is connection-pinned. Low risk,
but it changes `MCPServer.start()`. Note that on a 2026-pinned connection
`getClientCapabilities()` returns `undefined` — nothing in AgentBack reads it
today, but that should be re-checked before the switch.

**D7 — per-request DI context lifetime. RESOLVED (S4b), and more cheaply than
this proposal predicted.** The recommendation here was to wrap the returned
`Response` so the context closes when its body stream ends. That is not needed:
the SDK already owns the per-request server's lifetime and signals it. Probed
against a streaming tool, the order is

```
fetch() resolves -> tick0 -> tick1 -> tick2 -> server.onclose -> body drained
```

so `onclose` fires _after_ all streamed work and _before_ the body finishes —
exactly the right release point. `perRequestFactory` chains the context's
`close()` onto it (chained, never replacing any teardown the SDK installed).

Two assumptions that did **not** survive contact, worth recording so nobody
re-derives them: `ctx.requestInfo` is **not** the same object as the `Request`
passed to `fetch()` (the SDK reconstructs it), so a `WeakMap` keyed on the
outbound request silently misses and leaks every time; and closing when
`fetch()` resolves would truncate every streaming tool, because `fetch()`
returns _before_ the tool has done any work.

**D5 — MCP Apps.** `@modelcontextprotocol/ext-apps` still peer-deps SDK v1.
Needs a compatibility answer before Phase 2 ships, not a footnote.

---

## 7. Sequencing

Each step is independently shippable and independently revertable.

| Step    | Scope                                                               | Depends on |
| ------- | ------------------------------------------------------------------- | ---------- |
| **S1**  | ~~Memoize schema emission in `MCPServer`~~ — **SHIPPED**, see §4    | —          |
| **S2**  | ~~Host-neutral session binder~~ — **SHIPPED**, see §3               | —          |
| **S3**  | ~~Modern-era test harness~~ — **SHIPPED**, see §10                  | —          |
| **S4a** | ~~`protocol: 'stateless'` on the fetch host, opt-in~~ — **SHIPPED** | S1–S3      |
| **S4b** | ~~Express host + per-request DI context (D7)~~ — **SHIPPED**        | S4a        |
| **S5**  | `serveStdio`                                                        | S4         |
| **S6**  | MRTR: migrate the hand-rolled `confirm:` flow to `inputRequired`    | S4         |
| **S7**  | Flip the default; deprecate the old mounts                          | S4–S6      |

S1–S3 are pure refactors with no wire change and could land any time. S4 is the
first commit that changes bytes on the wire.

**S6 is a genuine simplification worth calling out.** AgentBack's `confirm:`
flow (issue a token in a `confirmation_required` error, client retries with it)
is a hand-rolled multi-round-trip request. MRTR is the same shape done at the
protocol layer, and `requestState` is _exactly_ the right tool for it — this is
the one place the earlier "perSession → requestState" instinct was pointing at
something real, just attached to the wrong feature.

---

## 8. Testing

The gap: **`InMemoryTransport.createLinkedPair()` is 2025-era only, and there is
no in-memory serving entry for 2026.** Every `packages/mcp` unit test and
`@agentback/testing`'s `createTestApp().mcp` use it.

The documented approach is to drive the handler in-process through a real client
transport with an injected `fetch` — no socket:

```ts
const handler = createMcpHandler(buildServer);
const transport = new StreamableHTTPClientTransport(
  new URL('http://test.local/mcp'),
  {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  },
);
```

`createTestApp().mcp` is public API, so this is a user-visible change to
`@agentback/testing` and needs its own decision about whether the test client
defaults to modern, legacy, or is selectable.

Coverage that must exist before S7:

- Both eras answering on one endpoint, same principal, **identical `tools/list`**
- `perRequest` visibility: two principals, two tool sets, same process
- Auth: the full 401/403 matrix on the modern path (Phase 1's tests are legacy-path)
- The `buildServer` memoization benchmark as a regression guard
- MRTR `confirm:` round-trip once S6 lands

---

## 9. Risks

| Risk                                        | Severity | Mitigation                                      |
| ------------------------------------------- | -------- | ----------------------------------------------- |
| Per-request construction cost               | **High** | S1 memoization, measured, benchmark-guarded     |
| `tools/list` split-brain across eras        | Medium   | D1: per-request discovery on both paths         |
| `perRequest` binder cost per request        | Medium   | D3: principal-keyed TTL cache                   |
| `createTestApp().mcp` behavior change       | Medium   | Public API — decide the default explicitly      |
| MCP Apps stuck on v1                        | Medium   | D5, before shipping                             |
| Resumable-SSE consumers                     | Low      | Legacy path keeps it; document the modern story |
| stdio `getClientCapabilities()` → undefined | Low      | Unused today; re-check at D4                    |

**Estimate: 2–3 weeks** — but scope it as an API redesign, not a transport port.
It deletes the primitive that `perSession`, session pinning, resumable SSE, and
the GET/DELETE routes are all built on. The Phase 1 outside voice was right to
push back on "transport follow-up" framing.

---

## 10. What the spike proved

§2-3 were originally written from the SDK's emitted types. They have now been
executed against a real `createMcpHandler` serving AgentBack's own `MCPServer`,
in-process, in
`packages/mcp-http/src/__tests__/integration/modern-era.integration.ts`.

**Confirmed:**

| Claim                                                 | Result                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| The factory runs once per HTTP request                | 4 requests -> **4** invocations (incl. the `server/discover` probe) |
| `era` is reported per construction                    | all `'modern'` on a negotiated modern connection                    |
| `requestInfo` (the Web `Request`) reaches the factory | present on **every** HTTP invocation                                |
| `authInfo` is strict pass-through                     | reaches the factory verbatim; the SDK verifies nothing              |
| Per-request discovery replaces `perSession`           | `admin` sees `[echo, secret]`, unscoped sees `[echo]`               |
| One factory + one endpoint serves both eras           | a `legacy`-pinned client is served, `era: 'legacy'`                 |

So §3's central claim — that `perSession` maps to **per-request discovery driven
by the validated principal**, not to `requestState` — is no longer an inference.
Scope-gated visibility computed inside the factory works exactly as the
transport mounts do today.

It also re-validates §4: a trivial four-request session is four `buildServer()`
calls, so un-memoized at 100 tools that alone would have been ~24ms of CPU.

**Still assumed, not proven:**

- **§5's host convergence.** The spike drives `handler.fetch` directly. Wiring
  it behind the Express host via `toNodeHandler` — and deleting the session
  machinery — is S4 and remains unexercised.
- **`subscriptions/listen`.** Understood from types only. AgentBack publishes no
  `list_changed` today, so it is off the critical path; D1's "one endpoint"
  answer assumes that stays true.
- **`serveStdio`.** Untouched (S5).
- **The `@agentback/testing` harness.** The spike proves the _pattern_;
  productizing it into `createTestApp().mcp` is a public-API change gated on
  D6 below.

**D6 — what era does `createTestApp().mcp` default to?** The in-process client
must pick one. **Recommendation: keep `legacy` as the default while the shipped
transports are 2025-era, and add an opt-in `{era: 'modern'}`** — flipping the
default silently would change what every existing app test exercises. Revisit
when S7 flips the serving default.
