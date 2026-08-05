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

## Custodial seat keys (`seat.keyStore`)

Every actor identity gets a platform-held secp256k1 keypair the first time it
**commits a turn** (its first successful command) — **custodial keypair at
birth, dormant**. A lease-free read/query never creates one: reads
deliberately never persist, and unauthenticated callers can supply arbitrary
ids (REST path params, MCP args), so keygen must never be reachable by
enumerating read-only routes. `ActorId` stays the working identifier; nothing
here signs anything, and no method returns private-key material except the
one-shot `takeCustody()`:

```ts
import {
  InMemorySeatKeyStore,
  SEAT_KEY_STORE_KEK,
  SEAT_KEY_STORE,
  seatKeyKekFromEnv,
} from '@agentback/actors';

app.bind(SEAT_KEY_STORE_KEK).to(seatKeyKekFromEnv()); // 32-byte AES-256-GCM key
app.service(InMemorySeatKeyStore); // binds SEAT_KEY_STORE
await app.start();

const store = await app.get(SEAT_KEY_STORE);
const record = await store.getByActor({type: 'cart', id: 'ada'}); // {seatKeyId, publicKey, ownerAccountId?, exportedAt}
const privateKeyHex = await store.takeCustody(record!.seatKeyId); // once only
```

`SEAT_KEY_STORE` is an **optional** dependency of `ActorRegistry` — an app
that never binds it keeps working exactly as before; no key row is ever
created. If it _is_ bound and its `create()` throws (store down, KEK
misconfigured at runtime), the triggering command turn fails closed — no
state commits — rather than silently skipping key creation. Private keys are
encrypted at rest (AES-256-GCM under the injected KEK) and never logged.
`@agentback/actors-redis`'s `RedisSeatKeyStore` is the durable adapter; both
pass `runSeatKeyStoreConformance` from `@agentback/actors/testing`.

## Events (event log)

A command turn may return `events` (domain facts) alongside `state`/`result`.
An event-log runtime persists them to a per-identity append-only log
**atomically** with the state/dedup commit:

```ts
app.component(EventSourcedActorsComponent);
// ...in a command:  return {state, result, events: [{type: 'CheckedOut', total}]};

const registry = await app.get(ACTOR_REGISTRY);
registry.subscribe(({actor, event}) => log(event.type));
const events = await registry.events('cart', 'ada'); // CommittedActorEvent[]
```

Two runtimes journal. `EventSourcedActorsComponent` is a superset of the
in-memory adapter and does both halves — it stores the log and delivers each
event to subscribers. `RedisActorsComponent`
([`@agentback/actors-redis`](../actors-redis)) journals **durably**, appending
to a per-identity Redis Stream inside the same Lua script that writes state and
the dedup record; it has no in-process delivery, so `registry.events(...)` works
against it and `registry.subscribe(...)` does not. That split is the exported
`ActorEventReader` (read the log) versus `ActorEventStore` (read **and**
subscribe); `runActorEventStoreConformance` from `@agentback/actors/testing` is
the shared contract both runtimes pass.

State stays authoritative — this is "state + event log", not full event
sourcing. Events are not appended on a rolled-back or replayed turn.

Every `CommittedActorEvent` carries a required `seatKeyId`, stamped at commit
by the journaling runtime from the acting seat's key row (see "Custodial seat
keys" above). `''` is the documented sentinel for no seat layer — an app that
never binds a `SeatKeyStore` still journals, just keyless.

## Runtimes (the `ActorRuntime` port)

| Component                                                             | Adapter               | Use                                         |
| --------------------------------------------------------------------- | --------------------- | ------------------------------------------- |
| `InMemoryActorsComponent`                                             | in-memory             | tests, dev, single-instance                 |
| `EventSourcedActorsComponent`                                         | in-memory + event log | the above **plus** a per-identity event log, delivered to subscribers |
| `RedisActorsComponent` ([`@agentback/actors-redis`](../actors-redis)) | Redis                 | cross-process serialization + durable state **and** a durable event log (no in-process delivery) |

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
