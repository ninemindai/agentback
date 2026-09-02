# @agentback/model-gateway

> The model-call seam: retries with classification, a circuit breaker, provider
> fallback, and **token-granular** metering — as language-model middleware.

`CoreBindings.FETCH` is the seam for outbound HTTP. This is the seam for the
call that actually costs money.

```bash
pnpm add @agentback/model-gateway
```

## Why middleware and not a `gateway.call()` API

Because a seam your traffic routes _around_ protects nothing.

An AI SDK `ToolLoopAgent` calls its model directly. If this package exposed its
own invocation API, `@agentback/agents` — and `generateText`, `streamText`, and
every other caller — would keep calling the provider underneath it, and the
retries, breaker and accounting would apply to nobody. Wrapping at the
**language-model** layer means everything downstream gets the policies without
knowing they exist.

```ts
import {wrapModel, CircuitBreaker} from '@agentback/model-gateway';
import {anthropic} from '@ai-sdk/anthropic';

const model = await wrapModel(anthropic('claude-sonnet-5'), {
  accounting: {meter}, // tokens, not calls
  retry: {attempts: 3}, // transport only
  breaker: new CircuitBreaker(), // one per app
  fallback: {models: [openai('gpt-5')]}, // providers go down
});

// A drop-in. Everything below now goes through the policies.
await generateText({model, prompt: 'hi'});
new ToolLoopAgent({model, tools});
```

`ai` is an **optional peer dependency**, imported lazily — a service that never
wraps a model never loads it. The port is declared structurally
(`LanguageModelLike`), so no provider-spec version enters AgentBack's public DI
surface — the same `ChatLike` / `AgentPort` discipline `@agentback/chat` and
`@agentback/agents` follow.

## The order is the design

```
accounting  → budget refuses before spending; sees the whole logical call,
              retries included, so one call bills once
  fallback  → outside retry (a blip retries the primary, it does not change
              providers) and outside the breaker (or the secondary's success
              would be recorded as the primary's health, and the circuit would
              never trip)
    retry   → transport blips only; never the reasoning
      breaker → per PHYSICAL attempt, so retries vote on health and a tripped
                circuit makes the remaining ones fail fast
        provider
```

## What each policy refuses to do

| Policy         | The rule that matters                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **retry**      | Retries 408/409/429/5xx. **Never** a 4xx, a cancelled call, or an open circuit — the same request fails the same way forever, and paying three times for it is strictly worse than failing once. Jitters every backoff, because a fleet retrying in lockstep turns a throttle into an outage. Honors `Retry-After`. |
| **breaker**    | Counts only failures that say something about the **provider's** health. A 400 is the request being wrong and would fail against a healthy provider — counting it would let one caller's bad input take the provider away from everyone. Half-open admits exactly **one** probe.                                    |
| **fallback**   | Fails over on 5xx, 429 and an open circuit. **Not** on a 400 (a second provider buys the same rejection twice) and **not** on a cancelled call (nobody is waiting for the answer).                                                                                                                                  |
| **accounting** | Bills in **tokens**. One request can be 500 tokens or 500,000, so a per-call counter describes traffic and says nothing about spend. Taps streams for the `finish` part, because streaming is the common case and metering that skipped it would miss most of the bill.                                             |

## Token accounting needs an ambient scope

A model is built once at boot; it cannot know which request it is serving. So
the _unit of work_ opens a scope and the model bills into it:

```ts
import {withModelScope} from '@agentback/model-gateway';

await withModelScope(
  {principal, correlationId: requestId, tokenBudget: 200_000},
  () => generateText({model, prompt}),
);
```

**`@agentback/agents` does this for you** — every turn runs inside a scope
carrying the turn's principal and correlation id, so a singleton agent on a
singleton model still produces per-principal, per-turn token events. Pass
`generate({tokenBudget})` to cap one turn.

Implemented with `AsyncLocalStorage` (`node:async_hooks`) — available on Node,
and on workerd/Bun/Deno with Node compatibility enabled. Outside a scope,
calls bill anonymously rather than failing.

## Not in scope (yet)

- **Response caching.** An exact-match cache on agent traffic has a near-zero
  hit rate — every call carries unique conversation history. The one that pays
  is the _semantic_ cache, which needs an embedding dependency and a similarity
  threshold; that is a design decision, not a mechanical addition. Provider-side
  **prompt caching** is the highest-leverage win here and is a prompt-**layout**
  discipline (static before dynamic), not a gateway feature.
- **Tier routing.** `fallbackPolicy` already proves the "call a different model"
  mechanism. What routing needs on top is a policy for _which_ step is cheap —
  and the gateway cannot know that; the caller can.

## Layering

Depends on `@agentback/common`, `context`, `core`, `metering`, `security`.
Optional peer: `ai`. See [docs/concepts/model-gateway.md](../../docs/concepts/model-gateway.md).
