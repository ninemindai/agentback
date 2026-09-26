# The model gateway

The seam in front of the model call: retry classification, a circuit breaker,
provider fallback, and **token-granular** metering.

## Wrapping a model

```ts
import {
  wrapModel,
  CircuitBreaker,
  ModelGatewayBindings,
  ModelGatewayComponent,
} from '@agentback/model-gateway';
import {anthropic} from '@ai-sdk/anthropic';
import {openai} from '@ai-sdk/openai';

app.component(ModelGatewayComponent);

const model = await wrapModel(anthropic('claude-sonnet-5'), {
  accounting: {meter: await app.get(MeteringBindings.METER)},
  retry: {attempts: 3},
  breaker: await app.get(ModelGatewayBindings.BREAKER), // ONE per app
  fallback: {models: [openai('gpt-5')]},
});
app.bind(ModelGatewayBindings.MODEL).to(model);
```

The result is a **drop-in** for the original model. `generateText`,
`streamText`, `ToolLoopAgent` and `@agentback/agents` all route through the
policies with no other change — which is why this is middleware and not a
`gateway.call()` API. A seam the agent runtime routes around protects nothing.

`ai` is an optional peer, imported lazily.

## Rules to know

- **One `CircuitBreaker` per app.** A breaker whose counters reset per request
  has no memory and therefore no opinion. `ModelGatewayComponent` binds the
  singleton for you.
- **Do not reorder the stack.** `gatewayMiddleware` emits
  `accounting → fallback → retry → breaker → provider`. Fallback must stay
  _outside_ the breaker (underneath, the secondary's success is recorded as the
  primary's health and the circuit never trips) and the breaker _inside_ retry
  (each attempt votes on health; once open the rest fail fast).
- **Retry is for the transport.** 408/409/429/5xx only. Never a 4xx, a
  cancelled call, or an open circuit.
- **"Cancelled" means the caller's `abortSignal` aborted — not an abort-shaped
  error.** A provider timing out on its own (`TimeoutError` from a `fetch`
  wrapper) is retried, fails over, and trips the breaker. Pass the signal when
  calling `isRetryable(err, signal)` yourself.
- **A 4xx never trips the breaker.** It is recorded neutral — it would fail
  against a healthy provider, and counting it would let one caller's bad input
  take the provider away from everyone.
- **The gateway owns retrying.** With `retry` on, the final error is marked
  `isRetryable: false` so the AI SDK's own `maxRetries` does not run the stack
  again. It is still the provider's error object.
- **A `Retry-After` longer than `maxDelayMs` fails the call at once.** It is
  read as seconds or an HTTP-date; retrying early earns another 429, and
  fallback can act on a fast failure.
- **Fallback secondaries are called raw** (no retry, no breaker). Wrap one
  with `wrapModel(m, {accounting: false})` to give it its own retry. Never
  with accounting: the primary already bills the call, to the model that
  served it.

## Token accounting needs a scope

A model built at boot cannot know which request it serves, so the principal
comes from an ambient scope the _unit of work_ opens:

```ts
import {withModelScope} from '@agentback/model-gateway';

await withModelScope(
  {principal, correlationId: requestId, tokenBudget: 200_000},
  () => generateText({model, prompt}),
);
```

`@agentback/agents` opens one per turn automatically, so a singleton agent on a
singleton model still emits per-principal token events sharing the turn's
`correlationId`. Cap one turn with `generate({prompt, tokenBudget})`.

Outside a scope, calls bill anonymously rather than failing.

## Gotchas

- `units` on a model usage event is **tokens**, not calls — a quota built on
  the old per-call unit caps the wrong thing.
- The budget is checked _before_ each call, so each call may overshoot by one
  response, including every call running in parallel in one scope. The
  provider decides how many tokens it emits.
- Scopes nest: an inner scope's spend counts against every enclosing budget,
  but keeps its own principal and correlation id.
- Streams bill when they **drain**, not when they start (the usage is in the
  `finish` part). A consumer that abandons a stream mid-body is still billed
  for what arrived, to the scope the call started in, with status `error`. So
  is a stream with an `error` part or no `finish`.
- A streamed agent turn refused by its `tokenBudget` fails the turn (metered
  failure, no quota charge), even though the stream itself ended normally.
- The breaker's `doStream` guard sees failures to _obtain_ a stream, not a
  stream that dies mid-body.
- There is **no response cache and no tier routing** — see
  [docs/concepts/model-gateway.md](../../../docs/concepts/model-gateway.md)
  for why, before building one on top.

Full rationale: [docs/concepts/model-gateway.md](../../../docs/concepts/model-gateway.md).
