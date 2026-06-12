# @agentback/extension-otel

> OpenTelemetry tracing across REST, MCP tools, and job queues. Depends on
> `@opentelemetry/api` only — bring your own SDK/exporter.

Implements proposal
[P1-4](../../docs/proposals/p1-4-extension-otel.md): one trace vocabulary for
_request → DI-resolved handler → MCP tool → enqueued job_, built on the
framework's existing seams (Express middleware chain, protected
`dispatch`/`dispatchTool`, the `JobQueue` port).

## What it provides

| Export                       | Kind        | Purpose                                                                           |
| ---------------------------- | ----------- | --------------------------------------------------------------------------------- |
| `installOtel` / `mountOtel`  | install fns | Per-request `SERVER` span middleware on the REST server (W3C `traceparent` aware) |
| `createOtelMiddleware`       | factory     | The raw Express middleware, for custom mounting                                   |
| `createOtelRestDispatchHook` | factory     | Composable `INTERNAL` span `rest.dispatch <Controller.method>` per request        |
| `createOtelMcpDispatchHook`  | factory     | Composable `INTERNAL` span `mcp.tool <name>` per tool call                        |
| `OtelJobQueue`               | `JobQueue`  | Port decorator: `PRODUCER` span on enqueue, `CONSUMER` span around the handler    |
| `getActiveTraceId`           | helper      | Trace id of the active span — the metering/billing correlation hook               |
| `TRACER_NAME`                | const       | The instrumentation-scope name (`@agentback/extension-otel`)                 |

## Wiring (NodeSDK)

The extension never registers an SDK. The app owns that choice — same
philosophy as `loggers`' pino opt-in:

```ts
// tracing.ts — import this FIRST, before the app
import {NodeSDK} from '@opentelemetry/sdk-node';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  serviceName: 'hello-rest',
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
  }),
});
sdk.start();
```

```ts
// app.ts
import {RestApplication} from '@agentback/rest';
import {installOtel, OtelJobQueue} from '@agentback/extension-otel';

const app = new RestApplication({});
await installOtel(app, {serverName: 'api'}); // middleware + dispatch hooks, before app.start()
await app.start();

// Jobs: wrap any JobQueue adapter at the port.
const queue = new OtelJobQueue(new InMemoryJobQueue());
```

## What's traced

- **REST request** (`installOtel`): `SERVER` span `<METHOD> <path>` with
  `http.request.method`, `url.path`, `http.response.status_code`; an incoming
  W3C `traceparent` joins the caller's distributed trace; 5xx → `ERROR`.
- **REST dispatch** (`createOtelRestDispatchHook`): `INTERNAL` span
  `rest.dispatch <Controller.method>` with `code.namespace`/`code.function`,
  `enduser.id` when authentication resolved a principal, and
  `recordException` + `ERROR` status on throw.
- **MCP tool** (`createOtelMcpDispatchHook`): `INTERNAL` span `mcp.tool <name>` with
  `mcp.tool.name`, `enduser.id` from the per-request `REQUEST_AUTH.clientId`
  when the transport authenticated the caller; Zod validation failures
  surface as the thrown error and mark the span errored.
- **Jobs** (`OtelJobQueue`): `PRODUCER` span `<queue> send` on enqueue
  (parents under the caller's active span) and `CONSUMER` span
  `<queue> process` around the handler, both carrying
  `messaging.destination.name` + `messaging.message.id`. Enqueue injects the
  W3C trace context (`traceparent`/`tracestate`) into the job's transport
  metadata envelope (`EnqueueOptions.meta`); process extracts it from
  `job.meta` and parents the `CONSUMER` span under it — producer and
  consumer share one trace, across processes, without touching the
  validated payload.

## Metering correlation

`UsageEvent` (in `@agentback/metering`) has an optional `traceId` field.
A `Meter`/`UsageSink` implementation may stamp it with `getActiveTraceId()`
to give billing records and traces one join key. This package deliberately
contains no metering-specific code — the coupling is the one optional field.

## No-op without an SDK

With no SDK registered, `@opentelemetry/api` returns no-op tracers: spans
cost (almost) nothing, no memory accumulates, and every traced surface
behaves exactly like its base implementation. Installing the extension
unconditionally is safe.

## Sampling guidance

Sampling is the SDK's job, not this extension's. For production, prefer a
`ParentBasedSampler(TraceIdRatioBasedSampler(p))` so sampled inbound
`traceparent`s stay sampled end-to-end, and tune `p` to your traffic; head
sampling at the edge plus parent-based here keeps REST → MCP → job spans of
one request in the same keep/drop decision. Use `AlwaysOnSampler` only in
dev/test.

## Dispatch hook composition

`installOtel` binds REST and MCP dispatch hooks under the framework hook tags,
so tracing composes with metering, audit hooks, and dispatcher subclasses. Call
it before `app.start()`; servers resolve and cache dispatch hooks on first use.
For custom wiring, bind `createOtelRestDispatchHook()` with
`REST_DISPATCH_HOOK_TAG` or `createOtelMcpDispatchHook()` with
`MCP_DISPATCH_HOOK_TAG`.

## Layering

Runtime deps: `@opentelemetry/api` plus the framework packages whose seams it
wraps (`rest`, `mcp`, `messaging`, `security`). Dev-only:
`@opentelemetry/sdk-trace-base` for in-memory span assertions in tests.
