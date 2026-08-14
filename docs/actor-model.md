# Actor programming model

AgentBack models an actor as a **DI-resolved service implementing a typed state machine with a stable address**. Code invokes `{actor type, actor ID, command}` through `ActorRegistry`; the runtime allows only one command to change that actor's state at a time.

See the interactive [programming-model diagrams](architecture/diagrams/actor-programming-model.html) for discovery and turn lifecycle.

## The model

| Concept                    | Role                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `Actor<S>`                 | Service contract requiring `initialState(id)`.                                  |
| `@actor` / `@actorCommand` | Zod contracts and extension metadata.                                           |
| `Component.services`       | Standard AgentBack registration path for actor classes.                         |
| `ActorRegistry`            | Discovers extensions and compiles service metadata.                             |
| `ActorRuntime`             | Routes each command to its identity's mailbox, serializes turns, commits state. |
| `ActorDefinition<S, C, R>` | Normalized lower-level adapter contract.                                        |

The service object is behavior, not durable state. Actor state remains an explicit method argument and return value, so instance lifetime does not affect persistence, rollback, or passivation.

## What it subtracts

The case for an actor runtime is easier to read as a list of code you stop writing than as a list of concepts you take on. Each row below is machinery a service typically hand-rolls around a mutable per-entity record, and where that machinery moves to instead.

| Hand-rolled around a per-entity record          | What replaces it                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| An advisory/distributed lock for "one writer"   | The per-identity mailbox. A lease on Redis, one-object-per-name on Durable Objects, a promise chain in process.     |
| An idempotency table plus a "did I already handle this?" read | `requestId` replay, committed in the **same** write as the state it produced.                        |
| An outbox table so state and its events cannot diverge | `events` returned from the turn, appended inside the same Lua script / atomic `put` as state and dedup.       |
| A cache in front of the hot entity              | State is loaded once per turn and lives in the turn. There is no second copy to invalidate.                         |
| Payload checks repeated at each call site       | Zod on the command. Input is parsed before the method runs; next state and output before commit.                    |
| A reaper for jobs that never finished           | Turn deadlines. A wedged turn is a **recorded failed turn** with a typed error and a freed seat, never a stuck row.  |
| Compensating writes when a handler half-mutates | Rollback. State is an argument and a return value, so a thrown or schema-invalid turn commits nothing.              |

The through-line is that each of these is normally correct-by-review rather than correct-by-construction: nothing fails loudly when a caller forgets the lock, skips the dedup read, or writes the event outside the transaction. Moving them into the turn makes forgetting them unrepresentable.

## What it does not subtract

Equally load-bearing, and the reason the list above stops where it does:

- **Your database.** Actor state is a JSON document addressed by `{type, id}`, not a query surface. There is no cross-identity query, join, or reporting path. Postgres stays.
- **Infrastructure, necessarily.** `actors-redis` does not remove Redis; it uses Redis to coordinate. Only the Durable Objects adapter genuinely co-locates state with compute — the "local read is ~100× a networked one" argument applies there and not to the Redis adapter, which loads state over the network per turn.
- **Durable queueing of pending commands.** The mailbox is in-flight only. A command that must survive a crash before it runs belongs in a job whose processor calls `invoke` (see "The mailbox model").
- **Side effects.** The runtime discards a state clone; it cannot unsend an email or unmake a payment. The outbox is still yours to write (see "State and side effects").
- **Cross-actor transactions, reentrancy, placement, activation, fairness, timers, supervision.** All explicitly out of scope.

## 1. Author an actor service

```ts
const CartState = z.object({items: z.record(z.string(), z.number())});
const AddItem = z.object({sku: z.string()});
const CartResult = z.object({itemCount: z.number()});

@actor('cart', {state: CartState})
class CartActor implements Actor<z.infer<typeof CartState>> {
  constructor(@inject('services.catalog') private catalog: Catalog) {}

  initialState() {
    return {items: {}};
  }

  @actorCommand('add', {input: AddItem, output: CartResult})
  async add(
    state: z.infer<typeof CartState>,
    input: z.infer<typeof AddItem>,
    ctx: ActorCommandContext,
  ) {
    await this.catalog.assertExists(input.sku);
    state.items[input.sku] = (state.items[input.sku] ?? 0) + 1;
    const itemCount = Object.values(state.items).reduce((a, b) => a + b, 0);
    return {state, result: {itemCount}};
  }
}
```

`@actor` contributes the service binding to `ACTOR_EXTENSIONS`. Each `@actorCommand` supplies one input/output contract. Commands are parsed before the method runs; next state and output are parsed before commit.

Actor services default to singleton scope because they hold behavior and injected dependencies, not per-actor state. A transient scope is also valid; serialization is keyed by actor identity, not service instance.

## 2. Contribute actors through a component

```ts
class CommerceComponent implements Component {
  services = [Catalog, CartActor];
}

const app = new Application();
app.component(InMemoryActorsComponent); // runtime + ActorRegistry service
app.component(CommerceComponent); // normal Component.services mounting
await app.start();
```

Component mounting registers each entry through `app.service()`. The `@actor` extension tag survives that path. On startup, `ActorRegistry` reads metadata without instantiating services, validates unique actor and command names, compiles normalized definitions, and registers them with `ActorRuntime`.

Actor instances are resolved through their original service binding only when `initialState` or a command method runs, so constructor injection and binding scope are honored.

## 3. Address and invoke

```ts
const actors = await app.get(ACTOR_REGISTRY);

const result = await actors.invoke(
  'cart',
  'customer-42',
  {name: 'add', input: {sku: 'keyboard'}},
  {requestId: 'checkout-7:add-keyboard'},
);
```

`cart/customer-42` is the state and serialization boundary. Another call using the same identity reaches the same logical state. `cart/customer-99` has independent state and may run concurrently.

`invoke` uses a command envelope because different decorated methods have different input/output types. For a typed call site, pass the **actor class** instead of its name: `actors.ref(CartActor, id)` returns a proxy whose methods mirror the `@actorCommand` methods, so `actors.ref(CartActor, id).add(input, {requestId})` is fully typed and routes through the same `invoke`. The proxy reads method _signatures_ (not the Zod schemas), so a command whose method declares no `input` parameter types its input as `unknown` — pass `{}`.

## The mailbox model

`invoke` is not a method call on the actor — it **posts a message** (the command envelope `{name, input}`) to the mailbox addressed by `{type, id}`. Each identity has its own mailbox, and the runtime drains it **one turn at a time** in submission order. `cart/customer-42` is a single serialized line of turns; `cart/customer-99` is an independent mailbox that may run concurrently. The in-memory adapter implements the mailbox as a per-identity promise chain; the Redis adapter as a per-identity lease — same contract, different backing. (The "One turn" steps below are what the runtime does once a message reaches the front of its mailbox.)

Both halves of an address are validated before anything is keyed on them: an actor **type** at `defineActor`/`@actor`, an **id** at every `ref`/`state`/`events`/query entry point. Blank is rejected, and so is any C0 control character (`U+0000`–`U+001F`). The second rule is not cosmetic — the in-process runtimes and the Redis journal subscriber key a seat on `type + U+0000 + id`, so an unchecked control character in a caller-supplied id (a REST path param, an MCP tool arg) would make `{type: 'a', id: 'b\u0000c'}` and `{type: 'a\u0000b', id: 'c'}` name the _same_ state, dedup, journal and cursor entries.

Sends are **request/reply — `ask`, not `tell`**. `invoke` resolves with the turn's result, or rejects if the handler throws or validation fails; there is no fire-and-forget primitive that posts a message and returns without awaiting the turn. That matches the callers — REST controllers and MCP tools need a reply to return — and it keeps the runtime honest: a command nobody awaits would need a durable inbox to survive a crash, and that is the job queue's role, not the in-process mailbox's.

For durable, asynchronous commands, enqueue a job (`@agentback/messaging`) whose processor calls `actors.invoke(...)`: the queue owns durability and retries, while the actor still owns per-identity serialization and state. (The Redis adapter persists completed turns but likewise does not durably queue _pending_ commands — see the Redis adapter section.)

## Queries

`@actorQuery(name, {input, output})` marks a **read-only** method `(state, input, ctx) => result`. Unlike a command it takes **no turn and no mailbox/lease** — the runtime reads a state snapshot and runs the method concurrently with commands and other queries — and it returns the result directly (not `{state, result}`). A query must not mutate the state it receives.

```ts
@actorQuery('total', {input: z.object({}), output: CartTotal})
total(state: z.infer<typeof CartState>) {
  return {total: priceOf(state.items)};
}
```

Call a query by envelope — `registry.query('cart', id, {name: 'total', input: {}})` — or through the typed proxy (`registry.ref(CartActor, id).total({})`), which exposes commands and queries together. Reads are lease-free on the in-memory and Redis adapters alike.

## Injecting an actor

`registry.ref(CartActor, id)` — pass the actor **class**, not its name — returns a typed proxy whose methods mirror the `@actorCommand` and `@actorQuery` methods. To avoid passing the registry around, inject a typed **accessor** with `@injectActor`:

```ts
class CartController {
  constructor(
    @injectActor(CartActor) private carts: ActorAccessor<CartActor>,
  ) {}
  // this.carts(id).add(input, {requestId});  this.carts(id).total({});
}
```

`@injectActor(CartActor)` resolves to `(id) => registry.ref(CartActor, id)`, so `this.carts(id)` is the typed proxy for that identity — no hand-written client class, and every call still routes through the runtime. (Do **not** inject the actor instance and call its methods directly — that bypasses the runtime.)

## Discovery lifecycle

```text
CommerceComponent.services
          │ app.service(CartActor)
          ▼
@actor extension binding
          │ @extensions.view(ACTOR_EXTENSIONS)
          ▼
ActorRegistry.start()
          │ validate + compile metadata
          ▼
ActorDefinition → ActorRuntime.register()
```

Discovery is frozen at application startup. Actor bindings must be mounted before `app.start()`. Startup fails on duplicate actor names, duplicate command names, missing actor metadata, or actors with no commands.

## One turn

For each invocation the runtime:

1. validates the command envelope and computes its fingerprint;
2. joins the mailbox keyed by `{type, id}`;
3. loads or initializes state through the DI-resolved actor service;
4. replays a matching committed `requestId`, when present;
5. validates method input and resolves the actor service through DI;
6. invokes the decorated method with cloned state, input, and context;
7. validates next state and method output;
8. commits state plus request fingerprint/result, then replies.

If resolution, the handler, or validation fails, the state clone is discarded and the request ID remains retryable.

## Turn deadlines

Every turn runs under a deadline drawn from its definition's **seat class**: `'capability'` (the default — a caller is waiting, so 30 seconds) or `'worker'` (back-office work nobody is blocked on, so 10 minutes). Declare it on `@actor`/`defineActor`, or set `deadlineMs` yourself; an explicit `deadlineMs` always wins.

```ts
@actor('nightly-import', {state: ImportState, seatClass: 'worker'})
class ImportActor {…}
```

**A timeout is a recorded failed turn, never a wedge.** A `receive` that outlives its deadline rejects the caller with a typed `TurnTimeoutError` and frees the seat immediately, so the next turn runs at once instead of queueing behind a promise that may never settle. The failed turn is then recorded: a journaling runtime appends an `actor.turn.timeout` entry (a reserved event type; the `actor.` prefix is the runtime's) to the identity's log, and every runtime logs the same line under the `agentback:actors:deadline` namespace — which is the whole record on `InMemoryActorRuntime`, the one runtime with no journal. Be honest about what that means operationally: `loggers` is debug-gated at every level, so the **console** line is only actually written when `DEBUG` matches the namespace (`DEBUG=agentback:actors:deadline:*`). A registered `onLog` hook is a separate matter, though: it fires for this record regardless of `DEBUG`, so an operator who wires a sink — not just a console — observes every timeout on `InMemoryActorRuntime` unconditionally too. On the journaling runtimes the marker is in the log regardless of log configuration either way, which is the record to rely on if nothing calls `onLog`.

That record is deliberately its **own** write, touching neither state nor the dedup record. Three consequences, all intentional:

- the timed-out turn commits nothing — the one commit point (state + dedup + journal) is untouched, and state stands where the last good turn left it;
- the `requestId` stays retryable. A timeout is not a cached failure result: retrying the same id runs the command again rather than replaying anything;
- the marker consumes a `seq`, so a journal reads in the order things actually happened.

The turn is **abandoned, not cancelled**. Nothing interrupts a `receive` that is still running, and side effects it already performed still happened. What it can no longer do is commit: each runtime re-checks its mutual-exclusion guard — the Redis lease token, an equivalent per-turn guard in process — immediately before the commit, with **no suspension point in between**. On Redis the deadline _races_ the state load and `receive`, and stops there — never the commit script — so a turn can never both commit normally and be recorded as failed, and a turn whose commit already landed can never be marked failed.

The race is not the whole deadline, though, because **a JS timer cannot preempt synchronous work**. A `receive` that busy-spins past `deadlineMs` blocks the event loop outright: no timer fires while it runs, and when it finally yields, the continuation — the guard check and the commit — runs as a microtask _ahead_ of the expired timer's callback. So every runtime also re-reads the clock at the commit boundary, and treats elapsed time past the deadline exactly as it treats an expired guard: `TurnTimeoutError`, a recorded failed turn, rollback, seat freed. Without it a sync-heavy turn committed normally on the in-process runtimes, and on Redis it failed as an `ActorLeaseLostError` — the starved renewal timers had let the lease lapse — with no timeout recorded anywhere.

There is still a deliberate corollary: **on Redis the deadline bounds the turn up to the commit boundary, not the commit itself.** Once the commit script has been issued, a commit that stalls will not produce a `TurnTimeoutError` — the caller waits on Redis. The _seat_ is still bounded, by the renewal cap below, so a stalled commit cannot wedge the identity; only that one caller waits. In process there is no such gap: the commit is synchronous, so the deadline covers the whole turn.

Nested calls attribute to the turn that actually timed out. An actor turn may invoke another actor (`@injectActor`), so an inner `TurnTimeoutError` propagates out through the outer turn's `receive`. It keeps naming the **inner** identity and request, and only the inner turn is recorded — to the outer turn a pass-through timeout is an ordinary thrown turn, and it rolls back like any other. One incident, one marker.

Two small edges worth knowing. A timeout marker's `seatKeyId` is always the `''` sentinel, even when the seat has a real key row: the registry stamps the acting key onto the turn context only _after_ the command method returns, and a timed-out turn's never did (the marker still identifies the turn by `actor` + `requestId`). And **every runtime races the state load**, `initialState` included, so a deadline can fire before `receive` is ever reached — a cold identity whose `initialState` hangs is a recorded failed turn like any other, not a caller that waits forever. What such a turn can be recorded _as_ is the one place the journaling runtimes differ: on Redis the marker's own `XADD` creates the identity's stream, so it lands in the log, while the event-sourced runtime has no stored identity to append to yet and gets the log line only. Every marker for a turn that reached `receive` lands on both.

## Concurrency and idempotency

```text
cart/customer-42:  add A ─────► add B ─────► clear
cart/customer-99:       add X ─────► add Y
                       (may overlap customer-42)
```

Commands for one identity are serialized. Different identities may run concurrently. Retrying an identical command with a committed `requestId` returns the prior result; reusing that ID for another payload is rejected.

There is no cross-actor transaction or reentrancy. Placement, activation, fairness, timers, and supervision remain out of scope.

## State and side effects

Do not keep durable state in class fields. The runtime can discard its state clone after a failure, but it cannot undo an email, HTTP call, payment, or unrelated database write performed by a method.

Production actors should persist an outbox with state, call idempotent services using `requestId`, or store intent for a worker. In-memory rollback is not a distributed transaction.

## Redis adapter

`@agentback/actors-redis` rebinds `ACTOR_RUNTIME` to a singleton `RedisActorRuntime`. It reuses the exported `RedisConnectionManager` from `messaging-bullmq`, coordinates each identity with a renewable lease token, and atomically commits JSON state plus the dedup result in Lua. The lease token is the sole mutual-exclusion guard: the commit script re-checks lease ownership in the same Lua call (`GET(lease) == token`), so a stale holder cannot write — no separate fencing token is needed when the store does the check-and-set atomically. Reads (`state()`) take no lease. `installRedisActors` can own its manager or share `BullMQMessagingComponent.connections`.

Renewal is capped by the turn's deadline (see "Turn deadlines"). The lease renews every `leaseMs / 3` for as long as the turn runs, but only up to `deadlineMs`; past that it stops and the lease lapses within one `leaseMs`, so a wedged turn releases its seat cluster-wide rather than holding it while every other caller fails on `acquireTimeoutMs`. Reaching the cap also flows into the existing `ActorLeaseLostError` path — a turn whose lease is on its way out must not commit, and `COMMIT_TURN`'s token check refuses it in any case.

This mode persists completed turns but does not durably queue pending commands. Durable request/reply queuing remains separate because the current `JobQueue` port has no result channel.

## Durable Objects adapter

`@agentback/actors-do` hosts turns **inside** a Durable Object — one object per identity, addressed by `idFromName` — on Cloudflare or self-hosted [celld](https://celld.dev) (the adapter sticks to the portable intersection of the two: `idFromName`, RPC stubs, atomic multi-key storage `put`; no Queues/KV/alarms). The platform's one-instance-per-name guarantee replaces the Redis lease as the *placement* half of mutual exclusion; per-turn serialization is still the object's own seat (workerd interleaves in-flight requests at await points). State, dedup record, and journal commit in one atomic multi-key `put`, and the layout respects the platform's per-entry caps (128 KiB per value KV-backed, 2 MB key+value SQLite-backed): the core record stays small, each committed request result lives in its own `dedup:<requestId>` key (O(1) replay lookup, FIFO-evicted via a `dedup-order` index with lazy **best-effort** deletes — a cleanup failure never reports a committed turn as failed), a turn may emit at most 100 events (one atomic put has a bounded entry count, enforced on every host so dev fails like production), and `requestId` is capped at 256 characters (it becomes a storage key). The deadline races load + `receive` only and the commit runs outside the race, so an abandoned turn never reaches its commit — the same caller-visible semantics as Redis, with `initialState` persistence re-checking first-writer-wins as the one remaining abandoned write. Errors cross the RPC boundary as envelopes and are revived typed (`TurnTimeoutError` keeps naming the turn whose deadline fired; the timeout marker write is itself best-effort and never masks that error). On Cloudflare, pass `{baseClass: DurableObject}` (from `cloudflare:workers`) to `createActorDurableObject` — RPC methods are exposed only from classes extending it, and that module exists only inside workerd, which is why the factory takes the base as a parameter. The journal ships its **read half** only: `registry.events()` works, `registry.subscribe()` throws — a Durable Object has no portable push channel back to every caller. `createInProcessDoActorRuntime()` is the in-process host for tests and single-process runs; it delivers stub calls concurrently and clones across the boundary, so the engine's own serialization is what tests exercise.

## Events (event log)

A command turn may return `events` alongside `state` and `result` — domain facts (`{type, …}`) describing what happened. `EventSourcedActorsComponent` binds an `ActorRuntime` that **persists those events to a per-identity append-only log atomically with the state/dedup commit**, then delivers them to subscribers. Read a log with `registry.events(type, id)` or react with `registry.subscribe(handler)`; each `CommittedActorEvent` carries the `actor`, a 0-based `seq`, the producing `requestId`, and the committing seat's `seatKeyId` (a required string; `''` is the "no attributable seat key" sentinel — either no `SeatKeyStore` is bound, or the entry is a system marker recorded outside a completed turn, which is always the case for a timeout marker). Events are not appended on a rolled-back or replayed turn.

This is **state plus an event log**, not full event sourcing: state stays the stored, authoritative value (not a fold of events). It delivers the "Event = fact" persistence — projections, audit, and react-to-what-happened subscribers — without an event-sourced authoring model.

`RedisActorRuntime` journals durably: it appends a turn's events to a per-identity Redis Stream **inside the same Lua script** that writes state and the dedup record, so the three cannot diverge, and `registry.events(type, id)` reads that log back. The remaining runtimes ignore a turn's `events`. Any further durable adapter must hold the same line: append in the same transaction as state + dedup, or not at all.

`registry.subscribe(handler)` works on both journaling runtimes, but they mean different things by "deliver". The in-memory one calls subscribers once, right after the commit. The Redis one **tails the durable streams**, which is the pattern to design consumers around: **the log is the source of truth, live delivery is best effort, and a reconnecting or restarted consumer replays by `seq`**. So delivery is at-least-once — **handlers must be idempotent by `(actor, seq)`, and late replay is normal, not an error path**. A consumer keeps its own cursor; nothing between the log and a handler filters, so every consumer is offered every event. A handler that throws is logged and skipped: it cannot stall the tail, affect a sibling consumer, or fail the turn that committed the event (delivery is entirely read-side). DI-registered `seat.journal.consumer` extensions ride one shared subscription, each individually validated at discovery and individually degradable at runtime — and their cursors are persisted per consumer id, so a restarted process resumes where each consumer left off instead of replaying every identity's whole history to every consumer on every boot. The cursor is written _after_ a consumer's handler returns, which keeps the semantics at-least-once: a crash between handling and the write redelivers, which is exactly what an idempotent consumer is built for. A consumer id the store has never seen starts from `seq` 0.

**Retention changes what "replay" can mean.** Nothing trims a journal by default, but `@agentback/actors-redis` takes an opt-in `journal.maxEventsPerIdentity` that caps each identity's log inside the same commit that appends to it. `seq` is unaffected — it comes from the identity's counter, never from stream length, precisely so trimming cannot corrupt numbering — so a capped log reads as a _suffix_ whose entries keep their committed seq values. What is no longer guaranteed is replay-from-zero: a consumer whose persisted cursor predates the oldest retained entry has a real gap. The host logs that gap (naming the cursor and the oldest entry it actually received) and continues from the oldest retained entry rather than throwing. Consumers that need complete history must archive — the `seat.journal.archiver` extension point exists for exactly this — or run with retention unset.

## Custodial seat keys

Every actor identity ("seat") gets a platform-held secp256k1 keypair, Nostr-compatible, at its first **command turn**. Precisely: the row is created inside the compiled actor's `receive`, after the command has passed schema validation and dedup, but _before_ the command method runs — it is not commit-gated. A first turn that then throws, times out, or fails output validation rolls its state back and still leaves a dormant key row behind. That is accepted design (the row is dormant, nothing signs, and `create()` is idempotent, so the retry reuses it), not an accident — but "at the first command turn" is the honest phrasing, not "at the first commit". `ActorId` stays the working identifier; the keypair is custodial and **dormant**: nothing in this layer signs anything, and no method returns private-key material except a one-shot `takeCustody()`.

`ActorRegistry` takes an optional `SEAT_KEY_STORE` binding (`@agentback/actors`'s `seat.keyStore` port). When bound, the registry idempotently calls the store's `create({type, id})` from the compiled actor's `receive` handler — the command/commit path, not `initialState` — so a lease-free read/query on a never-committed id never creates a row: reads deliberately never persist (see "The mailbox model" above), and since caller-supplied ids (REST path params, MCP args) are otherwise unauthenticated, keygen must not be reachable by enumerating read-only routes. An identity that already has a key row never regenerates. When unbound, no key row is ever created and every other actor behavior is unaffected; when bound but `create()` throws, the triggering turn fails closed (no state commits) rather than silently skipping key creation. `InMemorySeatKeyStore` is the reference adapter; `RedisSeatKeyStore` (`@agentback/actors-redis`) is the durable one, sharing the runtime's Redis connections and resolving a concurrent `create()` race for the same actor to one winning key via a Lua script. Both encrypt private keys at rest (AES-256-GCM under an injected KEK) and pass `runSeatKeyStoreConformance` from `@agentback/actors/testing`. `takeCustody()` **decrypts before it marks the row exported**, never the other way round: a wrong or rotated KEK must fail without consuming the one-shot, or a single misconfiguration would make the escape hatch fail permanently on the one key it was meant to release. Exactly-once is unaffected — the mark is still an atomic compare-and-set, so a caller that loses a concurrent race discards the plaintext and throws. See `packages/actors/README.md`'s "Custodial seat keys" section for the usage snippet.

An owner→seat binding (`ownerAccountId`) is recorded on the key row when a caller provides one at creation — this layer never enforces it.

## Layer boundary

Decorated services are the application authoring model. `ActorDefinition` remains the normalized runtime port so an in-memory, Durable Objects, Redis, or another adapter does not depend on decorators or DI metadata.

REST controllers, MCP tools, chat handlers, and job processors are callers. Actors do not automatically become transport endpoints and do not add an agent loop.

A production adapter must preserve per-identity serialization, cross-identity concurrency, schema validation, rollback, request replay, collision rejection, and atomic persistence of state plus request result. A queue acknowledgement and unrelated state write do not meet that contract.
