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

### OKF summary + on-demand fetch in `@agentback/introspection`

**What:** `get_okf_bundle` returns the full OKF bundle on every call. Add a summarized inventory (paths + titles) plus a full-fetch-by-path path so an agent pulls only what it needs.

**Why:** For large apps the full bundle is a heavy agent-token payload on every call. A summary keeps the agent's context cheap and lets it drill in selectively.

**Context:** Phase 1 ships the full bundle deliberately (the target app is the dev's own, usually small). The tool description carries a size caveat. Revisit once there's real usage to size against. `buildOkfBundle(ctx)` already returns `{files: {path, content}[]}` — a summary is `files.map(f => f.path)` plus a `get_okf_file(path)` accessor.

**Effort:** S
**Priority:** P2
**Depends on:** Phase 1 (`@agentback/introspection`) shipped.

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

### Adopt MCP protocol revision `2026-07-28` (stateless core)

**What:** Move `@agentback/mcp-http` onto the SDK v2 `createMcpHandler` entry point, which serves the `2026-07-28` stateless era and the 2025 era from one endpoint. Retire the session map, `Mcp-Session-Id` pinning, the GET-SSE and DELETE routes, and rework `perSession`.

**Why:** `2026-07-28` removes the `initialize` handshake and the protocol session entirely, so a server can scale behind a plain round-robin load balancer with no shared session storage. SDK v1 is on security/bugfix support for ~6 months from the v2 release (2026-07-28); the 2025 era itself has a 12-month deprecation window. This is not urgent, but it is not optional forever.

**Context:** Phase 1 (the v1→v2 package swap, zero wire change) shipped on `feat/mcp-sdk-v2` — commits `d5c87146`, `3b9b80a`. v2 speaks the 2025 era by default, so nothing is on the clock yet.

**`perSession` does NOT map to `requestState`** — this was corrected by the `/plan-eng-review` outside voice (Codex) and is the single most important note here. `perSession` decides tool _discovery_ (which tools appear in `tools/list`) and must therefore be resolvable on a first call. `requestState` only round-trips during a multi-round-trip (MRTR) exchange, after the server has already answered `resultType: "input_required"` — it is absent on a first call and structurally cannot drive visibility. The real destination is **per-request discovery computed from the authenticated principal**, with `createMcpHandler`'s per-request factory building the DI child context. `requestState` is for MRTR flow-state only, and is client-echoed untrusted input: HMAC (`createRequestStateCodec`) gives integrity, not authority — it does not address replay, entitlement revocation, or stale tenant config, so bind it to principal + expiry and re-check authority on re-entry.

Also unresolved, and all cheaper to decide before implementation than during it:

- **`tools/list` split-brain.** One endpoint serving both eras can hand a legacy client a session-scoped tool list and a modern client a per-request one. Decide whether the two eras may ever disagree for the same principal; "no" probably means per-request discovery everywhere, including the legacy path.
- **`MCPBindings.PROGRESS`.** `@tool` async generators currently relay `notifications/progress`. 2026 deprecates server-initiated flows; decide what progress means on a modern connection before the generator path silently no-ops.
- **Testing.** `InMemoryTransport.createLinkedPair()` is 2025-era only and there is no in-memory serving entry for 2026. Modern-era coverage must drive `createMcpHandler.fetch` through a `StreamableHTTPClientTransport` with a custom `fetch`. `@agentback/testing`'s `createTestApp().mcp` is public API, so this is a user-visible change.
- **MCP Apps.** `@modelcontextprotocol/ext-apps` still peer-deps SDK v1. Needs a compatibility decision, not a footnote, since 2026-07-28 makes extensions first-class.

**Design doc:** [`docs/proposals/mcp-2026-stateless.md`](docs/proposals/mcp-2026-stateless.md) — verified against the v2 emitted types, with a measured per-request cost budget and a 7-step sequence. Read it before starting; the notes below are the summary it expands.

**Effort:** L (scope it as an API redesign, not a transport port — it deletes the primitive `perSession`, session pinning, resumable SSE and DELETE are all built on)
**Priority:** P3
**Depends on:** Phase 1 shipped (done). Not blocked by anything external.

### Document and test browser CORS for the `/mcp` endpoint itself

**What:** Decide, document, and test how a browser-hosted MCP client reaches `/mcp` cross-origin. Today only the `/.well-known/oauth-protected-resource` discovery route answers `OPTIONS`; `/mcp` relies on `RestServerConfig.cors` being configured by the app.

**Why:** Browser MCP traffic to `/mcp` is preflighted (custom `MCP-Protocol-Version`, `Mcp-Session-Id`, `Authorization` and `content-type: application/json` are all non-simple), so an app that enables MCP-over-HTTP without also configuring `cors` gets a working curl and a broken browser client, with no error that points at CORS.

**Context:** Pre-existing — true under SDK v1 as well, not a regression from the v2 migration. Surfaced by the `/plan-eng-review` outside voice. `@agentback/mcp-http` now exports `PUBLIC_DISCOVERY_CORS` for the discovery document; `/mcp` is deliberately NOT open-CORS, because it is authenticated. The likely answer is documentation plus an integration test asserting the preflight works when `rest.cors` is set, not a new default.

**Effort:** S
**Priority:** P3
**Depends on:** —

### Resync `AGENTS.md` with `CLAUDE.md`

**What:** Bring the gitignored local `AGENTS.md` back in line with `CLAUDE.md`, or generate it from `CLAUDE.md`.

**Why:** `AGENTS.md` is what non-Claude harnesses (Codex, Cursor) read. It drifted ~71 lines behind `CLAUDE.md` between 2026-07-09 and now, so those harnesses work from a stale architecture description.

**Context:** `/AGENTS.md` is explicitly gitignored (`.gitignore:27`) and was deliberately untracked in `e373b60`, so this is a local-workflow question, not a repo doc-surface one. The MCP SDK v2 drift specifically was patched locally during the v2 migration review. If the file is meant to stay in sync, generating it from `CLAUDE.md` in `website/build.mjs` (which already derives docs) beats hand-maintaining two copies.

**Effort:** S
**Priority:** P3
**Depends on:** A decision on whether `AGENTS.md` should be tracked at all.

### Port per-tool rate limiting to the fetch/edge host

**What:** Implement a fetch-shaped equivalent of `toolRateLimitMiddleware` so `McpHttpOptions.rateLimit` throttles on the native/edge host, not only under Express.

**Why:** `rateLimit` is documented as per-tool, per-caller throttling for `tools/call`, but it is Express middleware and the fetch host has no middleware chain, so it has never applied there. `installMcpHttp` chooses the host automatically from `rest.listener`, so the user never opts into the gap. Until the port lands, that combination now **throws at mount** rather than silently not throttling — which fixes the danger but leaves edge deployments with no throttling option at all.

**Context:** Surfaced by the 2026-07-30 `/plan-eng-review` (finding D4). Pre-existing: zero occurrences of `rateLimit` in `fetch.ts` as of `v0.8.0`. The Express implementation is `packages/mcp-http/src/tool-rate-limit.ts`, built on `rate-limiter-flexible`, which is runtime-neutral enough to reuse — the work is the seam, not the algorithm. Note that under `protocol: 'stateless'` there is no session, so the bucket key must come from the authenticated principal (and see the `cachedPerPrincipal` lesson: `AuthInfo.clientId` is the OAuth _client_ id, not a per-user identity).

**Effort:** M
**Priority:** P3
**Depends on:** — (the throw makes the gap safe in the meantime)

### Interop-test against a released older MCP client

**What:** Add a test that drives a stateless AgentBack endpoint with a _released older_ `@modelcontextprotocol/client` version, not just the one in the lockfile.

**Why:** Every current test runs against `@modelcontextprotocol/client@2.0.0`. Serving 2025-era clients from the same endpoint is the central compatibility promise of `protocol: 'stateless'`, and nothing verifies it against a client that predates the v2 rewrite.

**Context:** Surfaced by the `/plan-eng-review` outside voice (Codex), 2026-07-30. Partly refuted at the time — the suite does use real sockets, real spawned child processes and the real SDK client rather than in-process fakes — but the narrow point stands: one client version is not interop. Likely shape is a devDependency on a pinned older client under an alias, exercised in `stateless.integration.ts`.

**Effort:** M
**Priority:** P3
**Depends on:** —

### Client-compatibility matrix before deleting the session machinery

**What:** Publish a matrix of client SDK versions, protocol revisions, transports and behaviours (resumability, `GET`/`DELETE`, session lifecycle) that the session machinery currently serves, with explicit removal criteria — **before** S7 deletes it.

**Why:** S7 plans to delete ~138 session references, the `GET`/`DELETE` routes and `event-store.ts` one release after the default flips. Treating that as cleanup is a Hyrum's Law bet: anything depending on resumability or session lifecycle breaks even though the endpoint still claims 2025 compatibility. The two-release split keeps the _flip_ reversible; it does not make the _deletion_ reversible.

**Context:** Surfaced by the `/plan-eng-review` outside voice (Codex), 2026-07-30. Relatedly, the flip date in `docs/proposals/mcp-2026-stateless.md` is currently justified by "Phase 2 shipped" rather than by evidence anyone wants it — gate it on adoption signal (example coverage, a documented rollback switch, one release of explicit opt-in) rather than on the phase being done.

**Effort:** S
**Priority:** P3
**Depends on:** Blocks the S7 deletion step (not the flip).
