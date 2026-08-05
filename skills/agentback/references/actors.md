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

A command turn may return `events` (domain facts). An event-log runtime persists
them to a per-identity append-only log **atomically** with the state/dedup
commit:

```ts
app.component(EventSourcedActorsComponent);
// in a command:  return {state, result, events: [{type: 'CheckedOut', total}]};

const registry = await app.get(ACTOR_REGISTRY);
registry.subscribe(({actor, event}) => log(event.type));
const events = await registry.events('cart', 'ada'); // CommittedActorEvent[]
```

Both `EventSourcedActorsComponent` and `RedisActorsComponent` journal, and both
deliver. `EventSourcedActorsComponent` does both halves in memory (log +
delivery to subscribers). `RedisActorsComponent` journals **durably** — a
turn's events are appended to a per-identity Redis Stream inside the same Lua
script that writes state and the dedup record — and delivers by tailing those
streams. The exported `ActorEventReader` (read the log) vs `ActorEventStore`
(read **and** subscribe) split still stands for a runtime that implements only
the reader: there, `registry.subscribe()` throws. Both runtimes pass
`runActorEventStoreConformance` from `@agentback/actors/testing`.

**Consumer contract: idempotent by `(actor, seq)`; late replay is normal.** The
durable log is the source of truth and live delivery is best effort, so
handlers are called at least once per event — the Redis adapter replays by
`seq` on every reconnect, and a restarted process replays from the start. A
handler that throws is logged and skipped; it never stalls the tail or fails
the committing turn. DI-registered `seat.journal.consumer` providers are hosted
on **one** shared subscription and degrade to skip + log individually.

State stays authoritative — this is "state + event log", not full event
sourcing. Events are not appended on a rolled-back or replayed turn.

Every `CommittedActorEvent` carries a required `seatKeyId`, stamped at commit
by the journaling runtime from the acting seat's key row. `''` is the
documented sentinel for no seat layer bound — journaling still works, keyless.

## Runtimes (the `ActorRuntime` port)

| Component                                          | Adapter               | Use                                         |
| -------------------------------------------------- | --------------------- | ------------------------------------------- |
| `InMemoryActorsComponent`                          | in-memory             | tests, dev, single-instance                 |
| `EventSourcedActorsComponent`                      | in-memory + event log | the above **plus** a per-identity event log, delivered to subscribers |
| `RedisActorsComponent` (`@agentback/actors-redis`) | Redis                 | cross-process serialization + durable state **and** a durable event log, delivered by tailing it (at-least-once) |

`installRedisActors(app, {connection: {url: process.env.REDIS_URL}})` swaps in
the Redis runtime; the actor and controller don't change. Every adapter passes
the shared `runActorRuntimeConformance` suite.

## Custodial seat keys (`seat.keyStore`)

Every identity gets a platform-held secp256k1 keypair (Nostr-compatible) the
first time it **commits a turn** (its first successful command) —
**custodial, dormant, nothing signs**. A lease-free read/query never creates
one: reads never persist, and ids are otherwise caller-supplied and
unauthenticated, so keygen must not be reachable by enumerating read-only
routes. `ActorRegistry` takes an **optional** `SEAT_KEY_STORE` binding
(`@agentback/actors`'s `seat.keyStore` port); when bound, key creation is
idempotent (an identity that already has a key row never regenerates); when
unbound, no key row is ever created and actors work exactly as before; when
bound but `create()` throws, the triggering turn fails closed.

```ts
import {
  InMemorySeatKeyStore,
  SEAT_KEY_STORE,
  SEAT_KEY_STORE_KEK,
  seatKeyKekFromEnv,
} from '@agentback/actors';

app.bind(SEAT_KEY_STORE_KEK).to(seatKeyKekFromEnv()); // 32-byte AES-256-GCM key
app.service(InMemorySeatKeyStore); // or RedisSeatKeyStore from actors-redis
```

Private keys are encrypted at rest and never logged; only the one-shot
`store.takeCustody(seatKeyId)` ever returns one (second call fails). `get`/
`getByActor` return public metadata only. An `ownerAccountId` is recorded on
the key row when a caller provides one — never enforced. See
`packages/actors/README.md`'s "Custodial seat keys" section.

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
