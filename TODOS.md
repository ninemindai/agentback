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

### Finish MCP protocol revision `2026-07-28` (S6, S7)

**What:** Two steps remain: migrate the hand-rolled `confirm:` flow to native
multi-round-trip requests (S6), and flip `protocol` to `'both'` by default then
retire the session machinery (S7).

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
