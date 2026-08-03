# TODOS

## Examples

### ~~Session caching of introspection builders~~ — CLOSED, measured, not worth it

**Decision (2026-08-02): do not build.** The TODO's own gate was "don't build
until a perf problem is measured." Measured, at three scales (synthetic app,
warm, 10–30 iterations):

| tools | routes | `buildModel` | `buildSchemaInventory` | `buildOkfBundle` |
| ----- | ------ | ------------ | ---------------------- | ---------------- |
| 25    | 10     | 0.07 ms      | 0.08 ms                | 0.26 ms          |
| 100   | 40     | 0.15 ms      | 0.22 ms                | 1.00 ms          |
| 250   | 100    | 0.24 ms      | 0.50 ms                | 3.88 ms          |

There is no perf problem to solve. For scale: `buildServer()` costs 6.04 ms at
100 tools and is paid on **every request** under stateless serving; these
builders cost less and are paid only when an agent explicitly calls
`inventory` / `get` / `get_okf_bundle`, which is a discovery action, not a hot
path.

Caching would trade invalidation correctness — which the original entry
correctly identified as the only real complexity — for under 4 ms on an
infrequent call. That is a bad trade, and a cache that goes stale when a
binding changes would make the introspection surface _lie_ about the app,
which is worse than being slow.

**Revisit if** `buildOkfBundle` exceeds ~50 ms on a real app (roughly 3000+
tools at the measured slope), or if a caller is shown to poll it in a loop.
Reopen with the measurement attached.

### ~~Validate 2026 transport headers before debiting the rate limiter~~ — CLOSED, spec verified, shipped

**Decision (2026-08-03): spec claim confirmed; fixed by ordering, not by
re-keying.** Both this entry and the Origin one below rested on unverified
readings of the `2026-07-28` spec. Both were checked against the published text
before any code changed.

**Verified.** [Streamable HTTP § Standard Request
Headers](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http):
`Mcp-Method` is required for all requests, `Mcp-Name` for `tools/call` /
`resources/read` / `prompts/get`, and "These headers are **REQUIRED** for
compliance." § Server Validation: servers that process the body **MUST** reject
a header/body disagreement with `400` + `-32020` (`HeaderMismatch`), and the
failure conditions explicitly include a _missing_ required header.

The two open questions are answered from the SDK source
(`@modelcontextprotocol/server@2.0.0`, `src-CX2iR2pK.mjs`), which implements a
named 9-rung inbound ladder:

- **Which era?** Modern only — `validateStandardRequestHeaders` is documented
  "Never enforced on legacy traffic".
- **Before or after our limiter?** After. `standard-header-validation` is rung 7
  and runs inside `statelessHandler.fetch()`, which both hosts call _after_
  `rateLimiter.check()`.

**One correction to this entry's own reasoning.** The limiter runs _after_ auth,
so with the default `strategyAuth.required: true` an unauthenticated flood is
401'd and never reaches it. The shared `anon` bucket only exists when anonymous
calls are allowed — and there it is already exhaustible by _well-formed_
requests, so malformed ones are not a privileged vector. This was a
quota-correctness bug, not a distinct DoS hole. What made it worth fixing is
**amplification**: `tallyToolCalls` counts every array element, and a batch
carrying modern elements is refused at rung 2, so one POST debited N points for
zero executed tools.

**Not done as suggested:** keying the debit off `Mcp-Method`/`Mcp-Name` would
contradict the spec's own note that intermediaries rate-limiting on mirrored
headers "SHOULD verify that the `MCP-Protocol-Version` header indicates a
version that requires header–body validation … rather than trusting unvalidated
header values." Ordering was the right fix.

**Shipped:** `rejectedBeforeDispatch` (`tool-rate-limit.ts`) delegates to the
SDK's exported `classifyInboundRequest` and decides _whether to debit_ only — it
never answers, so the SDK stays the sole owner of the wire format. Wired on both
hosts. Covers shape, era classification (both `-32020` cross-check cells) and
envelope rungs; a _missing_ standard header is validated a rung later by an
un-exported SDK function and is deliberately not mirrored — pinned by a test
that fails if a future SDK moves that check earlier.

### ~~Tighten `Origin` matching, and decouple it from `rest.cors`~~ — CLOSED, shipped

**Decision (2026-08-03): diverge from the SDK's flat hostname comparison —
precision follows the source.** The open question this entry recorded was
"whether to diverge from the SDK's comparison semantics". Answer: yes, but
selectively. Rather than one rule for everything, each entry is matched at the
precision it was _declared_ at:

| declared as               | matched                              |
| ------------------------- | ------------------------------------ |
| a CORS origin string      | exact `scheme://host[:port]`         |
| a CORS RegExp             | by testing the pattern               |
| explicit `allowedOrigins` | by hostname (unchanged)              |
| localhost defaults        | by hostname (dev servers move ports) |

**(a) resolved.** `cors: {origin: 'https://app.example.com'}` no longer admits
`http://app.example.com` or `:8443`. Explicit `allowedOrigins` deliberately
KEEPS hostname matching: those are its shipped, documented semantics and
narrowing them would 403 callers who already set the option. The fix lands
exactly where the widening was introduced (the derivation) and nowhere else.

**The bigger win was the case this entry buried at the bottom.** A RegExp
`cors.origin` used to collapse to `'any'` — a _restrictive_ config got LESS
protection than a wildcard, the least defensible of the three cases. Both Codex
passes flagged it independently. Regexes are pure, so they are now evaluated per
request. A **callback** origin still answers `'any'`: `CustomOrigin` is
`(origin, callback) => void`, asynchronous and free to have side effects, so a
transport guard cannot invoke it per request.

**(b) resolved as: keep deriving.** The concern was that CORS governs whether a
browser may _read_ a response while Origin validation governs whether the
request is _accepted_. True, but the precision fix dissolves most of it — the
derived policy now says exactly what CORS said rather than a widened version,
and `allowedOrigins` remains the override for a deployment whose REST and MCP
browser clients genuinely differ. Decoupling would mean asking for the same
origins twice, which is the second-source-of-truth problem this avoided.

**Shipped:** `OriginRule` / `originAllowed` / `describeOriginRules`
(`session.ts`), consumed by both hosts. The characterization test that pinned
the widening now asserts the opposite and is renamed — it did its job.

### ~~Refund rate-limiter points when the transport rejects a request~~ — CLOSED, shipped

**Decision (2026-08-03): built, alongside the pre-check rather than instead of
it.** This entry deferred refund because it is not strictly more complete — it
trades a closed race for an open one. That reasoning still holds, which is why
both mechanisms now run:

- **Predicted** (`rejectedBeforeDispatch`) — no debit at all for the rungs the
  SDK's exported classifier can see. No race, because nothing is spent.
- **Observed** (`RateLimitDecision.refund`, via `reward()`) — covers the rungs
  it cannot see, by reacting to a 4xx from the transport.

The pre-check still carries the amplifying case (a batch debiting N points for
zero executed tools), so the refund's debit-then-refund window applies only to
the narrow remainder — which is what makes the combination worth shipping when
refund alone was not.

**Scoped to transport-level refusals.** A tool that runs and throws answers 200
with a JSON-RPC error and stays debited: that work was performed.

**One robustness bug found while building it.** Registering the refund on
`res.on('finish')` assumed a full Express response; a `res` without an event
emitter threw an _unhandled rejection inside the middleware_, breaking the
request rather than skipping the accounting. Now guarded on
`typeof res.on === 'function'` — refund is best-effort by design and must never
be why a request fails. Caught by an existing unit test's mock, which is exactly
what that mock is for.

### ~~Decide the Origin-validation default for a browser-reachable `/mcp`~~ — CLOSED, spec verified, shipped

**Decision (2026-08-03): confirmed as a MUST, and it predates 2026 — defaulted
on, derived from `rest.cors`.**

**Verified.** [Streamable HTTP §
Security](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http):
"Servers **MUST** validate the `Origin` header on all incoming connections to
prevent DNS rebinding attacks… If the `Origin` header is present and invalid,
servers **MUST** respond with HTTP 403 Forbidden."

**This entry's framing was wrong in our favour, twice:**

1. The clause is **not new in 2026-07-28** — identical wording is in
   [2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
   and has been there since 2025-03-26. The permissive default was never
   conformant on any Streamable HTTP revision; the 0.9.0 flip only made it easy
   to hit. So "verify before acting" resolved in favour of acting.
2. **Default-on is not the breaking change assumed here.** The spec conditions
   the 403 on `Origin` being _present_, and the SDK's `validateOriginHeader` is
   documented "A missing/empty `Origin` header passes: non-browser clients do
   not send one." Every MCP client, `curl` and stdio bridge is unaffected; only
   a browser request can newly fail, which is the case being defended.

**Shipped:** when `allowedOrigins` is unset the stateless mount derives the
allowlist from `rest.cors` — localhost plus the origins CORS names — because
those origins are already the app's statement of which browsers may call it, and
declaring them twice is a second source of truth. A CORS config admitting _any_
origin (`true`, `'*'`, a RegExp or callback) enumerates nothing, so that case
logs a warning and leaves validation off: locking down to localhost there would
break the browser client the app's own config admits.

**Scoped to the stateless mount deliberately.** The two paths read
`allowedOrigins` differently — the session transport exact-matches the raw
`Origin` header (`_allowedOrigins.includes(originHeader)`) while the stateless
path compares hostnames via `toHostnames` — so a derived `localhost` would 403 a
browser on `http://localhost:3000` under sessions. `protocol: 'legacy'` keeps the
old default; closing that gap needs the session path moved onto hostname
matching, which is a separate breaking decision.

### Finish MCP protocol revision `2026-07-28` (S7b only)

**What:** One step remains: retire the session machinery (S7b). S6 (native MRTR
`confirm:`) and S7a (the default flip) shipped in 0.9.0.

**Why:** The 2025 era has a 12-month deprecation window and SDK v1 is on
security-only support. Nothing is on the clock, but the default should
eventually be the era the ecosystem is moving to.

**Context — most of this is DONE.** Shipped and on `main`:

| step    | what landed                                                          |
| ------- | -------------------------------------------------------------------- |
| S1      | memoized tool compilation (63x faster `buildServer` at 100 tools)    |
| S2      | host-neutral `perSession` binder; fixed a live cross-host type bug   |
| S3      | modern-era test harness; proved the design against a running handler |
| S4a/S4b | `protocol: 'both'` on **both** hosts, per-request DI contexts        |
| S5      | `serveStdio` for stdio (`protocol: 'both'` on `MCPServerConfig`)     |
| D3      | `cachedPerPrincipal` — keeps a per-request binder cheap              |

Resolved along the way, so do **not** re-litigate: `perSession` maps to
per-request discovery from the authenticated principal (**not** `requestState`,
which is MRTR flow-state and absent on a first call); `tools/list` cannot
split-brain because discovery is per-request on both eras; `MCPBindings.PROGRESS`
is unaffected (progress is **not** deprecated in 2026-07-28 — verified); the
modern-era test harness exists.

**S6 is an ENHANCEMENT, not a blocker** — `confirm:` was proven to work unchanged
on the modern era, because it is userland (a tool error plus an input property)
with no era-specific machinery. Migrating it to `inputRequired` would give
conformant hosts a native confirmation prompt, but MRTR is modern-only, so it
must run alongside the token dance for as long as the legacy era is served.

**S7 is a release decision, not engineering work.** Flip the default in a minor,
with a deprecation warning one release earlier; delete the session machinery
(~138 refs, the GET/DELETE routes, `event-store.ts`) a release **later**, so the
flip stays reversible while `'legacy'` still works. Gated on the compatibility
matrix below.

**Still open:** MCP Apps. `@modelcontextprotocol/ext-apps` still peer-deps SDK
v1, which pnpm auto-installs into that subtree for `examples/hello-mcp-apps` —
the only remaining v1 copy in the tree. Needs a compatibility decision before
S7, not a footnote.

**Design doc:** [`docs/proposals/mcp-2026-stateless.md`](docs/proposals/mcp-2026-stateless.md)
— carries the measured cost budget, the resolved decisions (D1–D7) and what the
spike proved vs what is still assumed.

**Effort:** S6 M / S7 S (the work is sequencing and comms, not code)
**Priority:** P3
**Depends on:** S7's deletion step is blocked by the four removal criteria in
§5.1 of the design doc — the compatibility matrix now exists, and criterion 1
(more than one 1.x release covered) is not yet met.
