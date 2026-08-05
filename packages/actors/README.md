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

Two runtimes journal, and both do both halves. `EventSourcedActorsComponent` is
a superset of the in-memory adapter: it stores the log and delivers each event
to subscribers in process. `RedisActorsComponent`
([`@agentback/actors-redis`](../actors-redis)) journals **durably**, appending
to a per-identity Redis Stream inside the same Lua script that writes state and
the dedup record, and delivers by tailing those streams. The exported split is
`ActorEventReader` (read the log) versus `ActorEventStore` (read **and**
subscribe) — a runtime may implement only the reader, in which case
`registry.events(...)` works against it and `registry.subscribe(...)` throws.
`runActorEventStoreConformance` from `@agentback/actors/testing` is the shared
contract both runtimes pass.

**`subscribe` handlers must be idempotent by `(actor, seq)`, and late replay is
normal.** The log is the source of truth and live delivery is best effort, so a
handler is called *at least* once per event: the durable adapter replays by
`seq` whenever it reconnects, and a restarted process — holding no cursor —
replays an identity's log from the start. Order is per identity; a handler that
throws is logged and skipped, never retried and never able to stall or fail the
committing turn.

State stays authoritative — this is "state + event log", not full event
sourcing. Events are not appended on a rolled-back or replayed turn.

Every `CommittedActorEvent` carries a required `seatKeyId`, stamped at commit
by the journaling runtime from the acting seat's key row (see "Custodial seat
keys" above). `''` is the "no attributable seat key" sentinel and carries two
meanings: no seat layer — an app that never binds a `SeatKeyStore` still
journals, just keyless — **or** a system marker recorded outside a completed
turn. Timeout markers always carry `''` even when the seat does have a key row
(see "Turn deadlines" below).

## Turn deadlines (per seat type)

Every turn runs under a deadline, so a `receive` that never resolves can never
wedge a seat. Two bands, chosen by `seatClass` on the definition:

| `seatClass`              | Deadline | For                                                    |
| ------------------------ | -------- | ------------------------------------------------------ |
| `'capability'` (default) | 30s      | a caller is waiting — a REST request, MCP tool, agent turn |
| `'worker'`               | 10min    | back-office work nobody is blocked on                  |

```ts
@actor('import', {state: ImportState, seatClass: 'worker'})
class ImportActor {…}

// …or set the number yourself; an explicit deadlineMs always wins.
@actor('cart', {state: CartState, deadlineMs: 5_000})
class CartActor {…}
```

**A timeout is a recorded failed turn, never a wedge.** When a turn outlives its
deadline the caller gets a typed `TurnTimeoutError`, the seat is released
immediately for the next turn, and the failed turn is recorded: journaling
runtimes append an `actor.turn.timeout` entry to the identity's log (a reserved
event type — the `actor.` prefix belongs to the runtime, so never emit one from
a command), and every runtime logs it under `agentback:actors:deadline`. That
append is its **own** write, touching neither state nor the dedup record, so:

- the timed-out turn commits nothing — state stands where the last good turn
  left it;
- the `requestId` stays retryable. A timeout is not a cached failure result;
  retrying the same id runs the command again rather than replaying anything.

The turn is **abandoned, not cancelled** — nothing interrupts a `receive` that
is still running, and any side effect it already performed still happened (as
ever, the runtime rolls back actor state, not the world). What it can no longer
do is commit: each runtime re-checks its mutual-exclusion guard — the Redis
lease token, an equivalent per-turn guard in process — immediately before the
commit, with no suspension point in between. On Redis the lease also stops
renewing once the turn has run for its deadline, so the seat becomes claimable
across processes even if the holder never comes back. (On Redis the deadline
bounds `receive`, not the commit: a commit that stalls after `receive` returned
makes that one caller wait, but the renewal cap still bounds the *seat*.)

A **nested** timeout attributes to the turn that actually timed out. An actor
turn may invoke another actor (`@injectActor`); an inner `TurnTimeoutError`
propagates out through the outer turn's `receive` still naming the inner
identity and request, and only the inner turn is recorded. To the outer turn a
pass-through timeout is an ordinary thrown turn — it rolls back like any other.
One incident, one marker.

## Runtimes (the `ActorRuntime` port)

| Component                                                             | Adapter               | Use                                         |
| --------------------------------------------------------------------- | --------------------- | ------------------------------------------- |
| `InMemoryActorsComponent`                                             | in-memory             | tests, dev, single-instance                 |
| `EventSourcedActorsComponent`                                         | in-memory + event log | the above **plus** a per-identity event log, delivered to subscribers |
| `RedisActorsComponent` ([`@agentback/actors-redis`](../actors-redis)) | Redis                 | cross-process serialization + durable state **and** a durable event log, delivered by tailing it (at-least-once) |

`ActorRuntime` is the package boundary. Every adapter must pass
`runActorRuntimeConformance` from `@agentback/actors/testing` and provide: one
active turn per `{type, id}`; atomic commit of state + request id + result;
rollback on a thrown/invalid turn; replay of a committed `requestId`; concurrency
across unrelated ids; lease-free reads; and the definition's turn deadline —
`TurnTimeoutError` to the caller, nothing committed, the seat free at once, and
the `requestId` still retryable.

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
