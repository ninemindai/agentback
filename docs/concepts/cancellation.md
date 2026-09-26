# Cancellation and deadlines

An agent workload is slow, non-deterministic, and **priced per unit**. That
last property is what makes cancellation a correctness concern rather than a
nicety: a run nobody is waiting for does not merely waste a socket, it bills.
A loop that stops making progress does not error — every call succeeds, and it
costs money until someone notices.

AgentBack answers that with **one seam**: `CoreBindings.ABORT_SIGNAL`.

```ts
import {inject} from '@agentback/context';
import {CoreBindings} from '@agentback/core';

@get('/forecast/{city}', {path: CityPath, response: Forecast})
async forecast(
  input: {path: z.infer<typeof CityPath>},
  @inject(CoreBindings.ABORT_SIGNAL, {optional: true}) signal?: AbortSignal,
) {
  const res = await this.fetch(upstream, {signal});
  return Forecast.parse(await res.json());
}
```

Always inject it **optionally**. A plain service call has no ambient unit of
work, and `undefined` is the honest answer there — not a signal that never
fires.

## Where it comes from

Every entry point that owns a cancellable unit of work binds the signal into
that unit's context. Because DI resolution walks the context chain, anything
nested inside — a service, a projected tool, an agent turn — reaches the same
signal with no plumbing.

| Unit of work                  | Bound by                       | Fires when                                              |
| ----------------------------- | ------------------------------ | ------------------------------------------------------- |
| REST request (Express)        | `RestServer.invokeRoute`       | the client hangs up                                     |
| REST request (fetch/edge/web) | `RestHandler.run`              | the host aborts `Request.signal`                        |
| REST stream (`streamOf`)      | either of the two above        | the client hangs up, or the server stops (`CANCELLED`)  |
| MCP tool call                 | `MCPServer.requestContextFor`  | `notifications/cancelled`, or the connection drops      |
| Programmatic `callTool`       | the `{signal}` call option     | whatever the caller decides                             |
| Queue job attempt             | `JobContext.signal` (a field)  | `timeoutMs` elapses, or `cancel()` reaches this process |
| Agent turn                    | `AgentTurnOptions.abortSignal` | the ambient signal above, or an explicit one            |

**A queue job is the exception.** `@jobProcessor` methods are called with the
`JobContext` alone — there is no per-job DI context — so nothing is bound under
`ABORT_SIGNAL` for a job and nested services do not inherit it. The signal is
the `job.signal` field: hand it to whatever you call.

The reason is always a `DOMException` named `AbortError` carrying one of
`AbortReasons` (`@agentback/common`), so `fetch` and the AI SDK rethrow it
unchanged and `isAbortError()` recognizes it downstream. Hosts disagree about
their own abort reasons — workerd, Bun, Deno and `@hono/node-server` each pick
a different one — so the fetch path re-expresses the host's signal as ours and
a route reads the same everywhere.

### A finished response is not a disconnect

Node fires `close` on a response both when it finished and when the socket
died. AgentBack separates them with `writableEnded`: only the second aborts.
Without that guard every successful request would abort its own signal on the
way out, killing any background work the handler had handed it to.

### A `resumable:` stream inverts the rule on purpose

One route option deliberately breaks the "disconnect means stop" default. A
`@get(..., {streamOf, resumable})` route keeps its producer alive across a
dropped connection so a reconnecting client can resume it, which means its
`ABORT_SIGNAL` cannot be the socket's — it follows the **stream**, firing when
the resume window closes or the server stops (a stream that completes normally
is not aborted). Wiring the socket's signal
there would abort the generation the instant the client blinked and defeat the
feature. The cost is explicit: for the length of the window you are running
work nobody is reading. See
[the streaming guide](../guides/streaming.md#7-resumable-streams-sse).

## Agent turns

`AgentBindings.AGENT` reads the ambient signal off the resolution context and
forwards it to the model as `abortSignal`, so a caller who hangs up stops the
generation instead of paying for tokens nobody will read. An explicit
`generate({abortSignal})` wins. The signal is also bound on the turn context,
so every projected `@tool` inherits it; the AI SDK's own per-call signal, being
narrower, wins inside a tool.

## Queue jobs: the clock is the only real backstop

```ts
queue.process(
  Forecasts,
  async job => {
    const res = await fetch(url, {signal: job.signal});
    // …
  },
  {concurrency: 25, timeoutMs: 900_000},
);
```

An agent job has no natural end. A retry cap counts _attempts_, and a run
stalled **inside** an attempt — a provider holding a socket, a tool waiting on
a connection — stops counting while it keeps billing. `timeoutMs` is the
backstop, and it has three deliberate properties:

- **Abandoned, not killed.** Nothing in Node interrupts running code. On
  elapse the signal aborts (the cooperative half — a handler that passed it to
  `fetch` stops paying at once), the attempt is recorded failed, and the slot is
  freed. A handler that ignores its signal runs on with nobody reading its
  result. This is the same bargain [`@agentback/actors`](../actor-model.md)
  strikes for a turn deadline.
- **Never retried.** An abandoned attempt is terminal even under
  `attempts: 3`. Redelivering it re-runs work someone asked to stop, and on a
  deadline it buys the same hang on the next worker, and the one after that.
  On BullMQ this is enforced with `UnrecoverableError`, because with late acks a
  plain throw _is_ redelivered.
- **Opt-in.** There is no default. An unbounded handler keeps working exactly
  as before; set a budget on any queue whose handler calls a model or a
  third-party API.

### What `cancel()` can and cannot promise

`JobQueue.cancel(q, id)` removes a job that has not started. If it **has**
started, cancelling means aborting that attempt's signal — which only reaches a
worker **in this process**. A job picked up by another process keeps its own
registry and is unreachable from here; `cancel()` answers `false` and means it.

Cross-process cancellation of a running job needs a side channel (a Redis
pub/sub topic, a cancel flag the handler polls) and is deliberately not
implied by this API.

## Related

- [The error contract](errors.md) — how an aborted call surfaces to a caller.
- [The actor model](../actor-model.md) — per-turn deadlines and the
  abandoned-not-cancelled rule this follows.
