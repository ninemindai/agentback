# The model gateway

Two independent readings of what an agent backend needs — a layered reference
architecture and a list of systems worth building — put the same thing first:
a seam in front of the model call. It is where nearly all of the cost and
nearly all of the reliability live, and it is the one call in the system where
a bug is a bill.

`@agentback/model-gateway` is that seam.

## It is middleware, and that is the whole point

A seam your traffic routes _around_ protects nothing. An AI SDK
`ToolLoopAgent` calls its model directly, so a gateway with its own
`gateway.call()` API would sit beside the agent runtime rather than underneath
it — retries, breaker and accounting applying to whatever code remembered to
opt in.

Wrapping at the **language-model** layer inverts that. `wrapModel` returns a
drop-in replacement, so `generateText`, `streamText`, `ToolLoopAgent` and
`@agentback/agents` all route through the policies without a line of change.

```ts
const model = await wrapModel(anthropic('claude-sonnet-5'), {
  accounting: {meter},
  retry: {attempts: 3},
  breaker: await app.get(ModelGatewayBindings.BREAKER),
  fallback: {models: [openai('gpt-5')]},
});
```

The port is declared structurally, so `ai` stays an optional peer and no
provider-spec version reaches AgentBack's public DI surface.

## Ordering is a design decision, not a detail

```
accounting  → budget refuses before spending; sees the whole logical call,
              retries included, so one call bills once
  fallback  → outside retry, outside the breaker
    retry   → transport blips only
      breaker → per physical attempt
        provider
```

Two of those placements are load-bearing and easy to get backwards:

- **Fallback outside the breaker.** Underneath it, the secondary's success is
  recorded as the _primary's_ health, and the circuit never trips — you would
  have built a breaker that can only ever be closed.
- **Breaker inside retry.** Each physical attempt should vote on the provider's
  health, and once the circuit opens the remaining retries fail fast instead of
  hammering something already known to be down.

## What each policy refuses to do

The refusals carry more weight than the actions.

**Retry the transport, never the reasoning.** A 429, a dropped socket, a 503 —
the network having a bad second. A 400, a content filter, a context-length
overflow: the same request will fail the same way forever, and paying for it
three times is strictly worse than failing once. A cancelled call is never
retried either; someone asked for it to stop.

**Jitter is not decoration.** Without it every instance in a fleet retries on
the same schedule, and a brief provider throttle becomes a self-inflicted
thundering herd that keeps the provider down.

**The breaker counts only provider health.** A 400 would fail against a
perfectly healthy provider, so counting it would let one caller's malformed
input trip the circuit for everyone else. It is recorded as _neutral_: not a
failure, not a success, but it does release a half-open probe slot — otherwise
a probe answered with a 400 wedges the circuit shut forever.

**Half-open admits exactly one probe.** Releasing the whole backlog at once is
how a recovering provider gets knocked over a second time.

**Fallback is not free.** Keep prompts and tools to the intersection of what
both providers support, and eval on both. A fallback you have never exercised
is decoration, not resilience.

## Accounting: tokens, not calls

Before this package, `@agentback/metering` billed one unit per call. One
request can be 500 tokens or 500,000, so that number describes traffic and says
nothing about spend — and a quota built on it caps the wrong thing.

The gateway emits one usage event per model call with `units` = total tokens,
plus per-call input/output/cached counts in `meta`. Streams are tapped for
their `finish` part rather than skipped, because streaming is the common case
for an agent and metering that ignored it would miss most of the bill.

### The scope, and why it has to be ambient

A model is constructed once at boot. It cannot know which request it is
serving, so the principal cannot be captured at wrap time — it has to come from
the _unit of work_:

```ts
await withModelScope({principal, correlationId, tokenBudget}, () => …);
```

[`@agentback/agents`](../guides/agents.md) opens one per turn, so a singleton
agent on a singleton model still produces per-principal, per-turn token events,
and `generate({tokenBudget})` caps a single turn. Outside a scope, calls bill
anonymously rather than failing.

The budget is checked _before_ each call and the spend added after, so the last
call of a scope can overshoot by one response. The provider decides how many
tokens it emits; a bounded overshoot is honest, and pretending we can predict
the number would not be.

## Deliberately absent

- **Response caching.** An exact-match cache on agent traffic has a near-zero
  hit rate: every call carries unique conversation history. The cache that pays
  is _semantic_, which needs an embedding dependency and a similarity threshold
  — a design decision, not a mechanical addition. Provider-side **prompt
  caching**, the highest-leverage win of all, is a prompt-**layout** discipline
  (static content before dynamic, or the hit rate silently goes to zero) and
  not something a gateway can do for you.
- **Tier routing.** The "call a different model" mechanism already exists in
  the fallback policy. What routing needs on top is a policy for which step is
  cheap enough for a small model — and the gateway cannot know that. The caller
  can.

## Related

- [Cancellation and deadlines](cancellation.md) — the abort signal the retry
  policy honors between attempts.
- [Agents](../guides/agents.md) — the runtime that opens a scope per turn.
