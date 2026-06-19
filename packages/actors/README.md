# @agentback/actors

See the [programming-model guide](../../docs/actor-model.md) for the API,
concurrency rules, state discipline, and architecture diagrams.

> Decorated actor service classes compiled into a Zod-typed runtime port, with
> a single-process reference adapter.

Actor semantics fit AgentBack without turning the framework into an
orchestration runtime. The in-memory adapter here is the single-process
reference (tests, development, single-instance services); reach for
[`@agentback/actors-redis`](../actors-redis) for cross-process serialization and
durable state.

## What it provides

- Stable identity: `{type, id}`.
- Zod-validated state, commands, and results.
- Commands are JSON-serializable so request fingerprints remain portable.
- Per-identity serialization; different identities may execute concurrently.
- Failed or schema-invalid turns do not commit state.
- A committed `requestId` replays its result only for the identical command;
  reuse with a different payload is rejected.
- A DI binding (`ACTOR_RUNTIME`) and adapter conformance suite.
- `@actor`/`@actorCommand` authoring with extension-point discovery.
- Actor services contributed through a component's standard `services` list.

```ts
import {z} from 'zod';
import {
  actor,
  actorCommand,
  ACTOR_REGISTRY,
  InMemoryActorsComponent,
  type Actor,
} from '@agentback/actors';
import {Application, type Component} from '@agentback/core';

const State = z.object({value: z.number()});

@actor('counter', {state: State})
class CounterActor implements Actor<z.infer<typeof State>> {
  initialState() {
    return {value: 0};
  }

  @actorCommand('add', {
    input: z.object({amount: z.number()}),
    output: State,
  })
  add(state: z.infer<typeof State>, input: {amount: number}) {
    state.value += input.amount;
    return {state, result: state};
  }
}

class DomainComponent implements Component {
  services = [CounterActor];
}

const app = new Application();
app.component(InMemoryActorsComponent);
app.component(DomainComponent);
await app.start();

const actors = await app.get(ACTOR_REGISTRY);
await actors.invoke(
  'counter',
  'customer-42',
  {name: 'add', input: {amount: 1}},
  {requestId: 'command-123'},
);
```

## Semantics an adapter must preserve

`ActorRuntime` is the package boundary. Every adapter must pass
`runActorRuntimeConformance` from `@agentback/actors/testing` and provide:

1. one active turn per `{type, id}`;
2. atomic commit of state, request ID, and result;
3. rollback when the handler throws or output validation fails;
4. replay of the committed result for a duplicate request ID;
5. concurrency across unrelated actor IDs.

For a queue-backed adapter, command acknowledgement must be in the same durable
transaction as state and dedup-result persistence, or use an equivalent inbox
protocol. A plain `JobQueue.process()` handler plus an unrelated state write is
not sufficient.

## Non-goals

- No distributed directory, placement, or remote transport.
- No persistence in the in-memory adapter (single-process); use `@agentback/actors-redis` for durable, cross-process state.
- No activation/passivation, reminders, supervision, or reentrancy.
- No transactional user side effects. The runtime can roll back actor state;
  it cannot undo an HTTP call or database write performed by `receive`.
- No automatic REST/MCP projection or create-agentback template.
- No claim that agent loops should live in AgentBack.

## What's next

A Cloudflare Durable Objects adapter — a backend with native per-key
serialization and transactional storage — is the natural next adapter. Like
every adapter it must pass `runActorRuntimeConformance`, and it would add
crash/retry durability on top of the in-process contract.
