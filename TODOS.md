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
