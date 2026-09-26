# Cancellation and deadlines

One seam — `CoreBindings.ABORT_SIGNAL` — across every surface, plus a
wall-clock budget for queue jobs.

## Injecting the signal

```ts
import {inject} from '@agentback/context';
import {CoreBindings} from '@agentback/core';

@api({basePath: '/weather'})
class WeatherController {
  constructor(
    @inject(CoreBindings.FETCH, {optional: true})
    private readonly fetch: Fetch = globalThis.fetch,
  ) {}

  @get('/{city}', {path: CityPath, response: Forecast})
  async forecast(
    input: {path: z.infer<typeof CityPath>},
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
  ) {
    const res = await this.fetch(url(input.path.city), {signal});
    return Forecast.parse(await res.json());
  }
}
```

Rules:

- **Always `{optional: true}`.** A plain service call has no ambient unit of
  work; `undefined` is correct there.
- **`@inject` goes at slot 1+** when the route/tool declares schemas (slot 0 is
  the validated input bundle). With no schemas declared, `@inject` goes at
  slot 0 — a dummy slot-0 parameter plus `@inject` at slot 1 silently fails to
  resolve.
- Hand the signal to whatever spends time or money — `fetch`, a DB driver, the
  AI SDK. Injecting it and ignoring it changes nothing.

## Where the signal comes from

| Unit of work                      | Fires when                                              |
| --------------------------------- | ------------------------------------------------------- |
| REST request (Express or Web)     | the client hangs up                                     |
| REST stream (`streamOf`)          | the client hangs up, or `app.stop()` (`CANCELLED`)      |
| MCP tool call                     | `notifications/cancelled`, or the connection drops      |
| `callTool(name, input, {signal})` | whatever the caller decides                             |
| Queue job attempt (`job.signal`)  | `timeoutMs` elapses, or `cancel()` reaches this process |
| Agent turn                        | the ambient signal above, or an explicit `abortSignal`  |

DI resolution walks the context chain, so anything nested inside a unit of work
— a service, a projected `@tool`, an agent turn — reaches the same signal with
no plumbing. Precedence is narrowest-wins: an explicit `{signal}` on `callTool`
shadows the turn context, which shadows the request context.

**A queue job is the exception.** `@jobProcessor` methods are called with the
`JobContext` alone — there is no per-job DI context — so nothing is bound under
`ABORT_SIGNAL` for a job and nested services do not inherit it. The signal is
the `job.signal` field: hand it to whatever you call.

The reason is always a `DOMException` named `AbortError` carrying an
`AbortReasons` message. `isAbortError(err)` from `@agentback/common` tells
whether an error is abort-_shaped_ — it cannot tell who aborted, so never use
it to decide retries. Job queues decide that by the identity of their own
abort: a handler's own timed-out `fetch` still retries under `attempts`.

## Agent turns

`AgentBindings.AGENT` reads the ambient signal off the resolution context and
forwards it to the model as `abortSignal`, so an abandoned HTTP caller stops the
generation instead of paying for tokens nobody reads. An explicit
`generate({abortSignal})` wins.

## Queue jobs

```ts
queue.process(
  Forecasts,
  async job => {
    const res = await fetch(url, {signal: job.signal});
  },
  {concurrency: 25, timeoutMs: 900_000},
);
```

`timeoutMs` is **opt-in with no default**. Set it on any queue whose handler
calls a model or a third-party API: a retry cap counts _attempts_, and a run
stalled inside an attempt stops counting while it keeps billing.

Three properties, identical on the in-memory and BullMQ adapters (pinned by the
shared conformance suite):

1. **Abandoned, not killed.** The signal aborts, the attempt is recorded
   failed, and the seat is freed. Node cannot interrupt running code, so a
   handler that ignores its signal runs on with nobody reading its result.
2. **Never retried**, even under `attempts: 3`. Redelivering an abandoned
   attempt buys the same hang on the next worker.
3. **`cancel()` on a started job** aborts that attempt's signal — but only
   reaches a worker **in this process**. A job running elsewhere answers
   `false`. Cross-process cancel needs a side channel you build.

## Gotchas

- A Node response `close` event is not necessarily a disconnect — the framework
  checks `writableEnded`. Don't hand-roll this in a subclass.
- Do not add a global default `timeoutMs`; it would silently fail existing
  long-running handlers.
- `AbortSignal.timeout()`'s reason is a `TimeoutError`, not one of ours;
  `isAbortError()` accepts both — which is exactly why it cannot decide
  whether work should be retried.

Full rationale: [docs/concepts/cancellation.md](../../../docs/concepts/cancellation.md).
