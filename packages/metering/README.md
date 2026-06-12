# @agentback/metering

> Rail-neutral usage metering for REST + MCP calls. Per-principal
> `UsageEvent`s into pluggable sinks (the durable one is your audit log),
> plus a per-principal `QuotaService`.

Every dispatched REST request and MCP tool call is timed by the component's
dispatch hooks and recorded as a `UsageEvent`,
attributed to the request's principal — the same `{user}`/`{client}` the auth
layer produced, which _is_ the billable identity. The durable sink doubles as
the read-only audit log (who did what, and who was turned away).

See the [architecture doc](../../docs/architecture/metering-and-payments.md) for
the data flow and how it composes with `@agentback/payments`.

```bash
pnpm add @agentback/metering
```

## What it provides

| Export                                      | Kind           | Purpose                                                                                        |
| ------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `MeteringComponent`                         | `Component`    | Binds the default stack (in-memory sink + quota + `Meter`) **and** the REST/MCP dispatch hooks |
| `createMeteringRestHook`                    | hook factory   | Emits a `UsageEvent` per dispatched request (bound by the component)                           |
| `createMeteringMcpHook`                     | hook factory   | Emits a `UsageEvent` per tool call (bound by the component)                                    |
| `Meter`                                     | class          | `observe(descriptor, fn)` times `fn` and records the event (clock/id injectable)               |
| `UsageEvent` / `UsageSink` / `QuotaService` | types          | The event shape and the two pluggable interfaces                                               |
| `InMemoryUsageSink`                         | `UsageSink`    | Process-local, queryable (`all()` / `forPrincipal()`) — dev/test default                       |
| `JsonlUsageSink`                            | `UsageSink`    | Append-only JSON-lines audit log; `read()` replays it; survives restarts                       |
| `RedisUsageSink`                            | `UsageSink`    | Shared across processes over an injectable `RedisLike` (no `ioredis` dep)                      |
| `CompositeUsageSink`                        | `UsageSink`    | Fans one event to N sinks (record to audit **and** bill from one event)                        |
| `InMemoryQuotaService`                      | `QuotaService` | Per-principal cumulative units vs a limit map                                                  |
| `MeteringBindings`                          | binding keys   | `SINK` / `QUOTA` / `METER` / `TRACE_ID_PROVIDER` — rebind to swap implementations              |

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {inject} from '@agentback/core';
import {
  MeteringComponent,
  MeteringBindings,
  type InMemoryUsageSink,
} from '@agentback/metering';

const app = new RestApplication({});
app.component(MeteringComponent); // binds the stack + the dispatch hooks

// Read the meter from anywhere it's needed.
class UsageController {
  @get('/admin/usage')
  async usage(@inject(MeteringBindings.SINK) sink: InMemoryUsageSink) {
    return {events: sink.all()};
  }
}
```

The hooks are transparent passthroughs when no `Meter` resolves, so they are
safe to bind unconditionally. They compose with other dispatch hooks (tracing,
audit) — bind order is onion order. When
`@agentback/extension-otel`'s `installOtel` runs alongside, every
`UsageEvent` is stamped with the active `traceId`
(`MeteringBindings.TRACE_ID_PROVIDER`), joining billing to traces.

## The event

```ts
interface UsageEvent {
  id: string; // ulid; also the idempotency key
  at: string; // ISO timestamp
  principal: {kind: 'user' | 'client' | 'anonymous'; id: string};
  surface: 'rest' | 'mcp';
  operation: string; // 'Controller.method' or tool name
  status: 'ok' | 'error' | 'denied' | 'rate_limited' | 'payment_required';
  latencyMs: number;
  units: number; // billable units (default 1)
  cost?: {amount: string; currency: string}; // priced downstream, not here
  traceId?: string; // optional OTel correlation — Meter impls may stamp it via getActiveTraceId() from @agentback/extension-otel
}
```

`status` makes the log an audit trail, not a counter: a refused call
(`denied`/`rate_limited`/`payment_required`) is recorded with _why_, but only
`ok` bills by default. Sinks are idempotent on `id`, so replaying a log is safe.

## Sinks & fan-out

```ts
import {
  CompositeUsageSink,
  JsonlUsageSink,
  RedisUsageSink,
} from '@agentback/metering';

// Durable audit log + a shared Redis copy, from one event.
app
  .bind(MeteringBindings.SINK)
  .to(
    new CompositeUsageSink([
      new JsonlUsageSink('usage.jsonl'),
      new RedisUsageSink(redisClient),
    ]),
  );
```

`RedisUsageSink` takes any client matching `RedisLike` (`sadd`/`rpush`/`lrange`)
— pass your `ioredis`/`node-redis` instance; this package takes no Redis
dependency of its own.

## Quota

`QuotaService.check(principalId)` / `consume(...)` is the `metered?` enforcement
arm — per-principal limits independent of any payment rail. The default
`InMemoryQuotaService({limits})` is cumulative-vs-ceiling; a windowed or prepaid
policy is a downstream implementation of the same interface.

## Layering

Depends on `@agentback/{core,context,security,authentication,openapi,rest,mcp}`
(the metered servers subclass `RestServer`/`MCPServer`). Sits above the auth
stack — it consumes the principal auth produces — and pairs with
`@agentback/payments` (the `paid?` answer). For a runnable demo of
per-principal attribution, see `examples/hello-oauth2` (`GET /admin/usage`).
