# @agentback/actors

See the [programming-model guide](../../docs/actor-model.md) for the full API,
concurrency rules, state discipline, and diagrams; this is the front-page tour.

> Decorated actor service classes compiled into a Zod-typed runtime port: a
> stable `{type, id}` address, one serialized turn at a time per identity, and a
> swappable adapter.

An actor is a **DI service implementing a typed state machine with a stable
address**. State is an explicit method argument and return value — never an
instance field — so the runtime can serialize turns, validate every transition,
and roll back a failed one. Callers (REST controllers, MCP tools) reach an actor
through the registry; actors do not become endpoints by themselves.

## Authoring: commands and queries

```ts
import {z} from 'zod';
import {actor, actorCommand, actorQuery, type Actor} from '@agentback/actors';

const CartState = z.object({items: z.record(z.string(), z.number().int())});
const AddItem = z.object({sku: z.string(), qty: z.number().int().default(1)});

@actor('cart', {state: CartState})
class CartActor implements Actor<z.infer<typeof CartState>> {
  initialState() {
    return {items: {}};
  }

  // A command: (state, input, ctx) => {state, result, events?}. Mutates state.
  @actorCommand('add', {input: AddItem, output: CartState})
  add(state: z.infer<typeof CartState>, input: z.infer<typeof AddItem>) {
    state.items[input.sku] = (state.items[input.sku] ?? 0) + input.qty;
    return {state, result: state};
  }

  // A query: read-only, no turn, no lease — runs concurrently with commands.
  @actorQuery('count', {input: z.object({}), output: z.object({n: z.number()})})
  count(state: z.infer<typeof CartState>) {
    return {n: Object.values(state.items).reduce((a, b) => a + b, 0)};
  }
}
```

Commands and queries are validated (input before the method, output before
commit). A command's `events` are optional domain facts (see Events).

## Registering and invoking

Register actor classes through a component's `services` list (or
`app.service(CartActor)`); the registry discovers them at `start()`.

```ts
import {InMemoryActorsComponent, ACTOR_REGISTRY} from '@agentback/actors';

app.component(InMemoryActorsComponent); // ACTOR_RUNTIME + ActorRegistry
app.service(CartActor);
await app.start();

const actors = await app.get(ACTOR_REGISTRY);

// Envelope form (stringly-typed):
await actors.invoke(
  'cart',
  'ada',
  {name: 'add', input: {sku: 'kbd'}},
  {requestId: 'r1'},
);
await actors.query('cart', 'ada', {name: 'count', input: {}});

// Typed proxy — pass the actor CLASS; methods mirror commands + queries:
const cart = actors.ref(CartActor, 'ada');
await cart.add({sku: 'kbd'}, {requestId: 'r1'}); // command, with idempotency
await cart.count({}); // query
```

`{type, id}` is the address: same id = one serialized line of turns, different id
= concurrent. The `requestId` is an idempotency key — replaying it returns the
committed result without re-running.

### Inject the actor, not the registry

`@injectActor` gives a controller a typed accessor instead of the raw registry
or a hand-written client:

```ts
import {injectActor, type ActorAccessor} from '@agentback/actors';

class CartController {
  constructor(
    @injectActor(CartActor) private carts: ActorAccessor<CartActor>,
  ) {}
  // this.carts(id).add(input, {requestId});  this.carts(id).count({});
}
```

Never inject the `CartActor` instance and call its methods directly — that
bypasses the runtime (no serialization, rollback, or persisted state).

## Events (event log)

A command turn may return `events` (domain facts) alongside `state`/`result`.
`EventSourcedActorsComponent` is a superset of the in-memory adapter that
persists them to a per-identity append-only log **atomically** with the
state/dedup commit, then delivers them to subscribers:

```ts
app.component(EventSourcedActorsComponent);
// ...in a command:  return {state, result, events: [{type: 'CheckedOut', total}]};

const registry = await app.get(ACTOR_REGISTRY);
registry.subscribe(({actor, event}) => log(event.type));
const events = await registry.events('cart', 'ada'); // CommittedActorEvent[]
```

State stays authoritative — this is "state + event log", not full event
sourcing. Events are not appended on a rolled-back or replayed turn.

## Runtimes (the `ActorRuntime` port)

| Component                                                             | Adapter               | Use                                         |
| --------------------------------------------------------------------- | --------------------- | ------------------------------------------- |
| `InMemoryActorsComponent`                                             | in-memory             | tests, dev, single-instance                 |
| `EventSourcedActorsComponent`                                         | in-memory + event log | the above **plus** a per-identity event log |
| `RedisActorsComponent` ([`@agentback/actors-redis`](../actors-redis)) | Redis                 | cross-process serialization + durable state |

`ActorRuntime` is the package boundary. Every adapter must pass
`runActorRuntimeConformance` from `@agentback/actors/testing` and provide: one
active turn per `{type, id}`; atomic commit of state + request id + result;
rollback on a thrown/invalid turn; replay of a committed `requestId`; concurrency
across unrelated ids; and lease-free reads.

## Non-goals

- No distributed directory, placement, or remote transport.
- No persistence in the in-memory adapters (single-process); use
  `@agentback/actors-redis` for durable, cross-process state.
- No activation/passivation, reminders, supervision, or reentrancy.
- No transactional user side effects. The runtime can roll back actor state; it
  cannot undo an HTTP call or database write performed inside a turn.
- No automatic REST/MCP projection or create-agentback template.
- No claim that agent loops should live in AgentBack.

## What's next

A Cloudflare Durable Objects adapter — native per-key serialization and
transactional storage — is the natural next adapter. Like every adapter it must
pass `runActorRuntimeConformance`, adding crash/retry durability on top of the
in-process contract.
