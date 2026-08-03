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

### Validate 2026 transport headers before debiting the rate limiter

**What:** On modern-era requests, validate the required `Mcp-Method` / `Mcp-Name`
transport headers before `rateLimiter.check()` debits quota — or key the debit
off the validated header rather than the parsed body.

**Why:** `packages/mcp-http/src/fetch.ts` runs the limiter before
`statelessHandler.fetch()`, and the SDK validates those headers later. A
malformed request that will be rejected as `HeaderMismatch` still spends
points first. The bucket key is normally the caller's own principal, so mostly
they burn their own quota — but **anonymous callers share one `anon` bucket**
(the fetch host has no trustworthy IP), so a stream of malformed requests can
exhaust the shared anonymous quota for everyone. That is a cheap DoS on the
anonymous tier.

**Context:** Surfaced by the `/plan-eng-review` outside voice (Codex),
2026-08-02, against the 0.9.0 work. The 2026-07-28 Streamable HTTP revision
added these headers specifically so intermediaries can route and rate-limit
**without trusting the body**, which is an argument for keying the limiter off
them rather than off `tallyToolCalls`. The Express stateless mount has the same
ordering (`packages/mcp-http/src/index.ts`, the `expressApp.all` stateless
branch). Body parsing would still be needed for the legacy fallback and for
batch counting.

**Effort:** M
**Priority:** P2
**Depends on:** — (needs confirming which headers the SDK actually enforces, and
on which era, before reordering anything)

### Decide the Origin-validation default for a browser-reachable `/mcp`

**What:** Decide whether DNS-rebinding/Origin validation should be on by default
for HTTP `protocol: 'both'`, rather than only when `allowedHosts`/`allowedOrigins`
is configured.

**Why:** `packages/mcp-http/src/session.ts` enables the checks only when an
allowlist is set. Since 0.9.0 made `protocol: 'both'` the default and 0.9.0 also
documented `rest.cors` for browser MCP clients, it is now easy to ship a
browser-reachable `/mcp` with **no Origin validation at all** — the combination
the rebinding guard exists to stop. The permissive default was chosen so local
dev works out of the box; that argument is weaker now that browser access is a
documented path.

**Context:** Surfaced by the `/plan-eng-review` outside voice (Codex),
2026-08-02. Codex reads the 2026 Streamable HTTP spec as saying servers MUST
validate `Origin` on incoming connections; **verify that against the spec text
before acting** — the current default predates the flip and is not a regression
from it. Cheapest useful step is probably making `rest.cors` + no
`allowedOrigins` a loud startup warning for `/mcp`, which is the posture this
package already took for `rateLimit` on the fetch host. Full default-on is a
breaking change for local dev and needs its own decision.

**Effort:** S (warn) / M (default-on)
**Priority:** P2
**Depends on:** Confirming the actual spec requirement.

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
