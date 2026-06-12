# Proposal P1-4: `@agentback/extension-otel` — Tracing Across REST, MCP, and Jobs

**Status:** Implemented (2026-06-10).
**Packages touched:** new `extension-otel`; `rest`/`mcp` gain no deps (instrumented via existing seams).
**Related:** `extension-metrics` (Prometheus), `metering` (UsageEvent spine).

## Motivation

The framework's surfaces share one container but observability is per-surface
(metrics extension for Prometheus, metering for usage). The agent-era ask is
a trace that spans _request → DI-resolved handler → MCP tool → enqueued job_,
attributed to a principal. OpenTelemetry is the obvious vocabulary, and the
existing seams (protected `dispatch`, `Meter`-style wrappers, middleware
chain) make this an extension, not a core change.

## Design

### Dependency discipline

`extension-otel` depends **only on `@opentelemetry/api`** (the stable,
implementation-free interface). The app owns the SDK/exporter choice
(`NodeSDK`, OTLP, console) — same philosophy as `loggers`' pino opt-in. With
no SDK registered, `@opentelemetry/api` no-ops; the extension costs nothing.

### Surfaces

```ts
import {installOtel} from '@agentback/extension-otel';
installOtel(app, {serverName?: string});  // before app.start()
```

1. **REST**: an Express middleware mounted first (via the existing
   `mountX(server)` pattern used by extension-health/rate-limit) opens a
   `SERVER` span per request (`http.request.method`, `url.path`,
   route template once matched, `http.response.status_code`), extracts
   incoming W3C `traceparent` for distributed traces, and closes on
   `res 'finish'`. Principal attribution on REST requires seeing the
   per-request `Context`, which middleware cannot — so phase 1 **also ships
   `OtelRestServer extends RestServer`** (overriding `dispatch`, exactly the
   `MeteredRestServer` pattern) recording `enduser.id` and DI-resolution
   timing; the middleware alone covers apps that don't swap the server class.
2. **MCP**: `OtelMCPServer extends MCPServer` overriding `dispatchTool` —
   open an `INTERNAL` span `mcp.tool/<name>` (attrs: tool name, session
   presence, principal from `REQUEST_AUTH.clientId`), record Zod-validation
   failures as span events, set error status on throw. Bound via
   `app.server(OtelMCPServer)` exactly like `metering`'s `MeteredMCPServer` —
   the subclass-composition pattern is established; making the two subclasses
   stack (`class X extends Otel(Metered(MCPServer))`) motivates the follow-up
   noted below.
3. **Jobs**: a `JobQueue` decorator (port-wrapping class, not a subclass):
   `OtelJobQueue(inner)` — `enqueue` injects the current trace context into
   an envelope field (`opts.meta.traceparent`), `process` wraps the handler
   in a `CONSUMER` span linked to the producer span. Works over any Layer-1/2
   adapter because it composes at the port, pairing with P0-5.

### Metering correlation

When `MeteringBindings.METER` is bound, the active span's `trace_id` is
attached to emitted `UsageEvent`s (a nullable `traceId` field added to the
type — additive). One join key across billing and debugging.

### The stacking follow-up (flagged, not solved here)

`MeteredRestServer`/`OtelMCPServer`-style subclassing doesn't compose
(`Otel + Metered` requires a mixin or an interception seam in
`dispatch`/`dispatchTool`). Phase 1 ships the subclasses and documents the
limitation; the right fix — a small `onDispatch` hook chain on both servers —
is a separate core proposal informed by both consumers.

## Implementation plan

1. Package scaffold; REST middleware (`installOtel`/`mountOtel`); span
   lifecycle tests with `@opentelemetry/sdk-trace-base` in-memory exporter
   (dev dep).
2. `OtelMCPServer` + tests (tool span, error status, validation event).
3. `OtelJobQueue` port wrapper + propagation test over the in-memory adapter.
4. `metering`: optional `traceId` on `UsageEvent` (additive, no break).
5. README: NodeSDK wiring snippet, sampling guidance.

## Out of scope

- Bundling any OTel SDK/exporter; metrics/logs signals (traces only —
  metrics stay with `extension-metrics`); auto-instrumentation registration;
  the dispatch-hook composition seam (follow-up proposal).
