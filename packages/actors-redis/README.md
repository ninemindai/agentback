# @agentback/actors-redis

> Redis-backed `ActorRuntime` with renewable per-identity leases, JSON state persistence, and atomic state/dedup/journal commits.

This is the first durable adapter for `@agentback/actors`. Actor behavior stays local to each application process; Redis coordinates turns and persists state so multiple instances can address the same logical actor.

## Usage

```ts
import {mountComponent} from '@agentback/core';
import {BullMQMessagingComponent} from '@agentback/messaging-bullmq';
import {installRedisActors} from '@agentback/actors-redis';

const messaging = new BullMQMessagingComponent({
  connection: {url: process.env.REDIS_URL},
});

mountComponent(app, messaging, 'components.BullMQMessaging');
installRedisActors(app, {
  connections: messaging.connections,
  prefix: 'my-service:actors',
});
app.component(CommerceComponent); // services = [CartActor, ...]
await app.start();
```

Passing `messaging.connections` shares the existing Redis connection tree. The actor component does not close a shared manager. When `connections` is omitted, `RedisActorsComponent` creates and owns a manager from its `connection` option and closes it on application stop.

## Turn protocol

For `{actorType, actorId}` the adapter:

1. acquires a Redis lease (an atomic `SET NX`) keyed by identity;
2. renews the lease while the actor method runs;
3. checks the Redis dedup hash for `requestId` replay;
4. loads and validates JSON state, or calls `initialState`;
5. executes and validates the local actor definition;
6. runs one Lua script that verifies the lease and atomically writes state, the request result, and the turn's events;
7. releases the lease with compare-and-delete.

If a process crashes before commit, no state changes. If it crashes after commit but before replying, a retry sees the dedup record and returns the committed result. An expired lease holder cannot commit stale state.

## Journal

A command turn's `events` are appended to a per-identity Redis Stream (`…:log`) **inside the commit script** — one entry per event, carrying `seq`, `requestId`, `seatKeyId` and the event JSON. There is no second write to go wrong: a turn either commits its state, its dedup record and its events, or none of the three. `seq` is a gap-free per-identity counter (`…:seq`), advanced in that same script. `seatKeyId` is always written, `''` when the acting identity had no key row; `events()` surfaces it as a required field on every `CommittedActorEvent` and validates the read back against `CommittedActorEventSchema`, rejecting a stream entry that predates this field entirely.

```ts
const log = await registry.events('cart', 'cart-42'); // CommittedActorEvent[]
```

Reads are lease-free (`XRANGE` over the whole log). Nothing trims the stream yet — retention is not implemented.

## Delivery

`registry.subscribe(handler)` works here too: the adapter tails the identity streams and hands each committed event to every subscriber, completing the `ActorEventStore` port.

**The durable log is the source of truth; live delivery is best effort.** A subscription is one tail loop on its own connection, reading all known journals in a single multi-stream `XREAD`. It keeps the last `seq` it delivered per identity, and whenever it (re)connects it re-reads each log from the start and replays everything past that cursor before going live. A restarted process holds no cursor, so it replays from `seq` 0 — normal operation, not an error path. **Delivery is therefore at-least-once and consumers must be idempotent by `(actor, seq)`.** Order is guaranteed per identity, unspecified across identities. Nothing filters between the log and a handler: every consumer is offered every event.

Finding the streams to tail needs to know which identities exist, so the runtime keeps one `…:identities` set, re-written *before* the commit on **every** turn. It is deliberately outside the commit script: the script's keys all carry the `{type:id}` hash tag and one shared index key would make the commit cross-slot on Redis Cluster. Ordering is what makes it safe — the `SADD` is awaited before the script runs, so a turn that commits an event was preceded by an index write in that same call, and an addressed-but-never-committed identity may also be listed (an empty stream in the `XREAD`, delivering nothing).

What that does **not** give you is an inductive claim about the past. There is no per-process memo precisely so that a lost entry — an operator `DEL`, an eviction (this is the cold key while the journal streams stay hot), a failover that keeps a commit but loses the `SADD` — **self-heals on that identity's next turn**. An identity whose entry is lost and that never takes another turn stays undiscoverable to a *new* subscriber until it does; `events(type, id)` addresses the log directly and is unaffected.

DI-registered `seat.journal.consumer` extensions are hosted by `SeatJournalConsumerHost`, which takes **one** subscription and fans out to every provider — so a consumer costs a callback, not a connection. Providers are Zod-validated when discovered and one that throws degrades to skip + log, leaving its siblings running. `subscribe(fn)` remains the programmatic surface for non-extension callers.

```ts
const off = registry.subscribe(({actor, seq, event}) => {
  if (alreadyHandled(actor, seq)) return; // consumers dedup, and own their cursor
  project(event);
});
```

Limits: the multi-stream `XREAD` spans identities, so delivery is single-node (the commit path is not) — on Redis Cluster the streams would hash to different slots. A reconnect re-reads each identity's whole log; there is no partial replay from a stream id yet.

## Options

```ts
new RedisActorsComponent({
  connection: {url: process.env.REDIS_URL}, // when not sharing a manager
  prefix: 'agentback:actors',
  leaseMs: 30_000,
  leaseRetryMs: 25,
  acquireTimeoutMs: 15_000,
  dedupTtlSeconds: 86_400,
  blockMs: 1_000, // delivery: XREAD BLOCK window
  discoveryIntervalMs: 1_000, // delivery: how often new identities are picked up
});
```

State and results must be JSON-serializable. The dedup hash TTL is refreshed on each successful actor commit; `0` disables expiration and should only be used with an external retention policy.

## Guarantees and limits

- State commit, request-result recording, and the event-log append are one atomic commit.
- Redis does not roll back a script that fails midway, so the commit script type-checks every target key before its first write and puts the only remaining fallible write (the `seq` `INCRBY`) first. A failing commit leaves state, dedup and the log exactly as they were.
- The commit Lua re-checks lease ownership (`GET(lease) == token`), so an expired lease holder cannot commit — the lease token is the sole mutual-exclusion guard.
- The same actor is serialized across processes under normal Redis availability.
- Contending callers are not guaranteed strict FIFO ordering.
- Lease loss can let method bodies overlap briefly, but only the current holder can commit. Methods must follow the base package's side-effect discipline.
- Commands are synchronous request/reply calls; pending commands are not durably queued. A future BullMQ mode needs a result channel beyond the current `JobQueue` port.
- Actor keys use a Redis hash tag, keeping each turn's Lua keys in one Redis Cluster slot.
- Delivery is best-effort and at-least-once; consumers must be idempotent by `(actor, seq)`. A handler that throws is logged and skipped — its event is not retried, because the log can be replayed by `seq`.
- The identity index is written before the commit, never inside it, and re-asserted on every turn (no memo). It may over-approximate, and a lost entry self-heals on the identity's next turn — but an identity that never takes another turn stays undiscoverable to a new subscriber until it does.

## Testing

Unit tests run without Redis. Integration and shared conformance tests are gated by `REDIS_URL`:

```bash
REDIS_URL=redis://localhost:6379 pnpm exec vitest run \
  packages/actors-redis/dist/__tests__
```

## Custodial seat keys (`RedisSeatKeyStore`)

The durable adapter for `@agentback/actors`'s `seat.keyStore` port (custodial keypair at birth, dormant — see the base package's README). Shares `REDIS_ACTOR_CONNECTIONS`; a concurrent `create()` race for the same actor resolves atomically to one winning key via a Lua script, mirroring the runtime's lease discipline.

```ts
import {SEAT_KEY_STORE_KEK, seatKeyKekFromEnv} from '@agentback/actors';
import {RedisSeatKeyStore} from '@agentback/actors-redis';

app.bind(SEAT_KEY_STORE_KEK).to(seatKeyKekFromEnv());
app.service(RedisSeatKeyStore); // requires REDIS_ACTOR_CONNECTIONS (RedisActorsComponent)
```

Not Cluster-safe: `create()`'s Lua script touches an actor-indexed key and a seatKeyId-indexed record key, which are not co-located under one hash tag (unlike the actor runtime's per-identity keys) because `get(seatKeyId)` must stay reachable without knowing the owning actor. Verified against standalone Redis.
