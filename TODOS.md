# TODOS

## Examples

### Adopt AgentError across the demo and examples once released

**What:** `AgentError` (added in `@agentback/openapi`, commit `9cc545a`) shipped in **0.2.0** — this is now actionable: replace the hand-rolled error shape in the demo's `WeatherError` with `extends AgentError`, and adopt `AgentError` in `examples/` services that throw client-correctable errors.

**Why:** The demo's `WeatherService.WeatherError` currently hand-rolls the same `statusCode`/`code`/`publicMessage`/`retryable` fields that `AgentError` now provides (done deliberately so the demo keeps building against the published 0.1.2). Once `AgentError` is on npm, `extends AgentError` deletes that duplication and makes the demo the canonical example of the framework's client-error primitive — the same "flagship demo should use the supported path" argument that drove the createTestApp conversion.

**Context:** The duplication is documented inline in `agentback-demo/src/weather-service.ts` (the `WeatherError` class comment explicitly says "same shape as @agentback/openapi's AgentError ... can later extend AgentError once released"). Selector errors there default to 400 `invalid_input`; Open-Meteo failures use 502 `upstream_error`. `AgentError`'s constructor is `new AgentError(message, {status?, code?, issues?, hint?, retryable?, schema?, cause?})`, defaulting to status 400. The framework-side primitive and its tests already exist (`packages/openapi/src/agent-error.ts`, `agent-error.unit.ts`); this TODO is purely downstream adoption, gated on publish.

**Effort:** S
**Priority:** P3
**Depends on:** Satisfied — `AgentError` is published in `@agentback/*` 0.2.0.

## Introspection (Phase 1 follow-ups)

### Session caching of introspection builders

**What:** Memoize `buildModel`/`buildSchemaInventory`/`buildOkfBundle` per session/process with invalidation when the container's bindings change.

**Why:** Each `inventory`/`get`/`get_okf_bundle` call re-walks the DI container. Fine at dev scale; wasteful for a chatty agent on a large app.

**Context:** Builders are side-effect-free and deterministic for a stable container, so caching is safe as long as it invalidates on binding mutation. Don't build until a perf problem is measured — invalidation correctness is the only real complexity.

**Effort:** S
**Priority:** P3
**Depends on:** Phase 1 (`@agentback/introspection`) shipped.

### Console "Agents" playground tab

**What:** A prompt box in the existing `/console` that runs one agent turn against the running app's own `toHostTools`-projected tools and renders `result.steps` inline.

**Why:** The strongest magical-moment delivery for `@agentback/agents` — zero terminal setup, uses the live DI container; the Stripe-Shell pattern (a console that executes) is the biggest activation lever the 2026-07 DX review deferred.

**Context:** See `docs/proposals/harness.md` appendix "NOT in scope" + DX review D9/D25. Reuse surface: `console`/`console-theme` shell, `mcp-inspector`'s `callTool` UI. Design must resolve the conceptual collision with `console-chat`'s dock (that runs a coding agent over ACP; this runs the app's own AI SDK agent) and model-key handling in a browser context.

**Effort:** M
**Priority:** P3
**Depends on:** `@agentback/agents` v1 shipped; demand signal from metering `'agent'` `UsageEvent`s.

## MCP SDK v2 (Phase 2 and follow-ups)

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

### Resync `AGENTS.md` with `CLAUDE.md`

**What:** Bring the gitignored local `AGENTS.md` back in line with `CLAUDE.md`, or generate it from `CLAUDE.md`.

**Why:** `AGENTS.md` is what non-Claude harnesses (Codex, Cursor) read. It drifted ~71 lines behind `CLAUDE.md` between 2026-07-09 and now, so those harnesses work from a stale architecture description.

**Context:** `/AGENTS.md` is explicitly gitignored (`.gitignore:27`) and was deliberately untracked in `e373b60`, so this is a local-workflow question, not a repo doc-surface one. The MCP SDK v2 drift specifically was patched locally during the v2 migration review. If the file is meant to stay in sync, generating it from `CLAUDE.md` in `website/build.mjs` (which already derives docs) beats hand-maintaining two copies.

**Effort:** S
**Priority:** P3
**Depends on:** A decision on whether `AGENTS.md` should be tracked at all.
