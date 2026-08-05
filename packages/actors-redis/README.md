# @agentback/actors-redis

> Redis-backed `ActorRuntime` with renewable per-identity leases, JSON state persistence, and atomic state/dedup commits.

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
6. runs one Lua script that verifies the lease and atomically writes state plus the request result;
7. releases the lease with compare-and-delete.

If a process crashes before commit, no state changes. If it crashes after commit but before replying, a retry sees the dedup record and returns the committed result. An expired lease holder cannot commit stale state.

## Options

```ts
new RedisActorsComponent({
  connection: {url: process.env.REDIS_URL}, // when not sharing a manager
  prefix: 'agentback:actors',
  leaseMs: 30_000,
  leaseRetryMs: 25,
  acquireTimeoutMs: 15_000,
  dedupTtlSeconds: 86_400,
});
```

State and results must be JSON-serializable. The dedup hash TTL is refreshed on each successful actor commit; `0` disables expiration and should only be used with an external retention policy.

## Guarantees and limits

- State commit and request-result recording are atomic.
- The commit Lua re-checks lease ownership (`GET(lease) == token`), so an expired lease holder cannot commit — the lease token is the sole mutual-exclusion guard.
- The same actor is serialized across processes under normal Redis availability.
- Contending callers are not guaranteed strict FIFO ordering.
- Lease loss can let method bodies overlap briefly, but only the current holder can commit. Methods must follow the base package's side-effect discipline.
- Commands are synchronous request/reply calls; pending commands are not durably queued. A future BullMQ mode needs a result channel beyond the current `JobQueue` port.
- Actor keys use a Redis hash tag, keeping each turn's Lua keys in one Redis Cluster slot.

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
