# Actors — stateful entities behind a stable address

`@agentback/actors` adds **actors**: a DI service implementing a typed state
machine with a stable `{type, id}` address. The runtime runs **one turn at a
time per identity** (different identities run concurrently), validates every
transition with Zod, and rolls back a failed one. Use it for an entity that
needs a single writer at a time — a cart, a conversation, a counter, a room.

**State is an explicit method argument and return value — never an instance
field.** That is what makes turns serializable, failures rollback-able, and the
backing store swappable. Callers (REST controllers, MCP tools) reach an actor
through the registry; actors do **not** become endpoints by themselves.

## Authoring: `@actor`, `@actorCommand`, `@actorQuery`

```ts
import {z} from 'zod';
import {
  actor,
  actorCommand,
  actorQuery,
  type Actor,
  type ActorCommandContext,
} from '@agentback/actors';

const CartState = z.object({items: z.record(z.string(), z.number().int())});
const AddItem = z.object({sku: z.string(), qty: z.number().int().default(1)});
const Total = z.object({total: z.number().int()});

@actor('cart', {state: CartState})
class CartActor implements Actor<z.infer<typeof CartState>> {
  initialState() {
    return {items: {}};
  }

  // Command: (state, input, ctx) => {state, result, events?}. Mutates state.
  @actorCommand('add', {input: AddItem, output: CartState})
  add(state: z.infer<typeof CartState>, input: z.infer<typeof AddItem>) {
    state.items[input.sku] = (state.items[input.sku] ?? 0) + input.qty;
    return {state, result: state};
  }

  // Query: read-only, no turn, no lease. Returns the result directly.
  @actorQuery('total', {input: z.object({}), output: Total})
  total(state: z.infer<typeof CartState>) {
    return {total: Object.values(state.items).reduce((a, b) => a + b, 0)};
  }
}
```

- A **command** method is `(state, input, ctx) => {state, result}` (optionally
  `events`). Input is validated before the method; next state + result before
  commit. `ctx` is `{actor, requestId}`.
- A **query** method is `(state, input, ctx) => result` — **read-only**, takes
  no turn and no mailbox/lease, runs concurrently. It must not mutate `state`.
- Throw `AgentError` (`@agentback/openapi`) for client-correctable domain errors
  (→ 400 over REST); a plain `Error` is redacted to a generic 500.

## Registering and invoking

Register actor classes via a component's `services` list or `app.service(...)`;
the registry discovers them at `start()` and compiles them into the runtime.

```ts
import {InMemoryActorsComponent, ACTOR_REGISTRY} from '@agentback/actors';

app.component(InMemoryActorsComponent); // ACTOR_RUNTIME + ActorRegistry
app.service(CartActor);
await app.start();

const actors = await app.get(ACTOR_REGISTRY);

// 1. Envelope form (stringly-typed):
await actors.invoke(
  'cart',
  'ada',
  {name: 'add', input: {sku: 'kbd'}},
  {requestId: 'r1'},
);
await actors.query('cart', 'ada', {name: 'total', input: {}});

// 2. Typed proxy — pass the actor CLASS; methods mirror commands + queries:
const cart = actors.ref(CartActor, 'ada');
await cart.add({sku: 'kbd'}, {requestId: 'r1'});
await cart.total({});
```

`{type, id}` is the address: same id = one serialized line of turns, different
id = concurrent. `requestId` is an **idempotency key** — replaying it returns the
committed result without re-running; reusing it for a different payload is
rejected.

### Inject the actor, not the registry

`@injectActor` gives a controller a typed accessor — no hand-written client
class:

```ts
import {injectActor, type ActorAccessor} from '@agentback/actors';

@api({basePath: '/carts'})
class CartController {
  constructor(
    @injectActor(CartActor) private carts: ActorAccessor<CartActor>,
  ) {}

  @post('/{id}/items', {path: CartPath, body: AddItem, response: CartState})
  async add(input) {
    return this.carts(input.path.id).add(input.body, {
      requestId: input.headers['idempotency-key'],
    });
  }
}
```

`@injectActor(CartActor)` resolves to `(id) => registry.ref(CartActor, id)`, so
`this.carts(id)` is the typed proxy for that identity. **Never inject the actor
instance and call its methods directly** — that bypasses the runtime (no
serialization, rollback, or persisted state).

## Events (event log)

A command turn may return `events` (domain facts). `EventSourcedActorsComponent`
(a superset of the in-memory adapter) persists them to a per-identity
append-only log **atomically** with the state/dedup commit and delivers them to
subscribers:

```ts
app.component(EventSourcedActorsComponent);
// in a command:  return {state, result, events: [{type: 'CheckedOut', total}]};

const registry = await app.get(ACTOR_REGISTRY);
registry.subscribe(({actor, event}) => log(event.type));
const events = await registry.events('cart', 'ada'); // CommittedActorEvent[]
```

State stays authoritative — this is "state + event log", not full event
sourcing. Events are not appended on a rolled-back or replayed turn.

## Runtimes (the `ActorRuntime` port)

| Component                                          | Adapter               | Use                                         |
| -------------------------------------------------- | --------------------- | ------------------------------------------- |
| `InMemoryActorsComponent`                          | in-memory             | tests, dev, single-instance                 |
| `EventSourcedActorsComponent`                      | in-memory + event log | the above **plus** a per-identity event log |
| `RedisActorsComponent` (`@agentback/actors-redis`) | Redis                 | cross-process serialization + durable state |

`installRedisActors(app, {connection: {url: process.env.REDIS_URL}})` swaps in
the Redis runtime; the actor and controller don't change. Every adapter passes
the shared `runActorRuntimeConformance` suite.

## Key rules

- **Register with `app.service(...)`** (or a component's `services`) — `@actor`
  tags the class as an `ACTOR_EXTENSIONS` extension; the registry finds it at
  `start()`.
- **State is an argument/return, never a field.** Don't keep durable state on
  the instance.
- **Invocation is message-passing, not method calls.** `invoke`/the proxy post a
  command to the per-identity mailbox; there is no fire-and-forget `tell` (every
  send awaits its turn) — for durable async, enqueue a job that calls
  `actors.invoke(...)`.
- **No transactional side effects.** Rollback undoes actor state, not an email
  or HTTP call made inside a turn — use an outbox / idempotent downstreams.
- See [`docs/actor-model.md`](../../../docs/actor-model.md) and
  `examples/hello-actors` for the full model.
