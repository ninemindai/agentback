# @agentback/messaging-bullmq

> Durable Layer-2 adapter for the `@agentback/messaging` ports: BullMQ
> job queue + Redis Streams event bus. Same Zod schemas, same decorators,
> same conformance suite — swap one component and the bus survives restarts.

Implements all four ports — `JobQueue`, `EventBus`, `QueueAdmin`,
`Scheduler` — against Redis. `BullMQJobQueue` maps queues/workers onto BullMQ;
`RedisStreamsEventBus` is Redis Streams directly (`XADD` /
`XREADGROUP`-per-group / `XACK`-on-resolve), because consumer groups are
exactly the semantic the port promises. The adapter passes the shared
conformance suite from `@agentback/messaging/testing`.

## Usage

```ts
import {Application} from '@agentback/core';
import {BullMQMessagingComponent} from '@agentback/messaging-bullmq';

const app = new Application();
app.component(
  new BullMQMessagingComponent({connection: {url: process.env.REDIS_URL}}),
);
// JOB_QUEUE / EVENT_BUS / QUEUE_ADMIN / SCHEDULER are now rebound to the
// durable adapter; @jobProcessor / @subscriber classes need zero changes.
```

Component options:

```ts
new BullMQMessagingComponent({
  connection: {url, options, client}, // URL, ioredis options, or BYO client
  prefix: 'myapp', // BullMQ key prefix (default `bull`)
  eventBus: {
    prefix: 'lba:events', // stream key prefix
    blockMs: 1000, // XREADGROUP BLOCK window per poll
    reclaimMinIdleMs: 30_000, // pending entry idle time before reclaim
    reclaimIntervalMs: 15_000, // XAUTOCLAIM cadence per subscriber
  },
});
```

## Connection discipline

One shared Redis connection is a built-in deadlock: BullMQ `Worker`s require
`maxRetriesPerRequest: null` and issue blocking commands, and each
`XREADGROUP BLOCK` loop would starve every other command on the socket. The
adapter therefore holds **one base `IORedis` connection** for queues/admin
(plain request-response commands) and **`duplicate()`s it** — with
`maxRetriesPerRequest: null` — for every BullMQ `Worker` and every event-bus
subscribe loop. All duplicates are tracked; the lifecycle observer stops the
adapter in dependency order: **workers** (graceful — `worker.close()` waits
for in-flight jobs) → **queues** → **event-bus loops** → **connections**
(duplicates, then base).

## Semantics vs the in-memory adapter

The conformance suite asserts the shared contract; these deltas are
implementation texture you may notice in production:

| Behavior                    | In-memory (Layer 1)                                    | BullMQ/Redis (this package)                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId` dedup window        | Per-process seen-set; gone on restart                  | **Permanent until the job is removed** — a completed job with the same `jobId` still dedupes later enqueues (use `removeOnComplete` to bound it)                                                                              |
| `discardStalled`            | Discards any active job past the cutoff, synchronously | **Lock-expired jobs only** — a held lock means a live worker owns the job (BullMQ's stalled-checker re-queues those). Conformance opts out via `capabilities.syncDiscardActive: false`; the lock-expiry path has its own test |
| Event redelivery            | Immediate in-process retry                             | **At-least-once via `XAUTOCLAIM` reclaim** — an unacked entry is redelivered only after `reclaimMinIdleMs` idle, on the next `reclaimIntervalMs` tick (defaults 30s/15s; tune both down for tests)                            |
| Event history (`fromStart`) | Per-bus-instance buffer                                | The Redis Stream itself — history survives restarts and is shared by every bus instance using the same prefix                                                                                                                 |
| `cancel`                    | Waiting/delayed only                                   | Same contract; a job that raced into active (now locked) reports `false`                                                                                                                                                      |
| Cron/interval (`Scheduler`) | Recorded, not fired                                    | **Fires for real** — BullMQ Job Schedulers (`upsertJobScheduler`), upserted by `when.key`, `unschedule` removes scheduler + pending iteration                                                                                 |

Validation discipline is identical on both sides of the wire: `enqueue` /
`publish` Zod-parse before anything reaches Redis, and consumers re-validate
on receipt — a payload written by an older deployment fails into `failed`
(via `UnrecoverableError`, skipping retries) instead of crashing the worker
loop.

## Wire format

The adapter owns its on-Redis shapes; both carry the transport metadata
envelope (`EnqueueOptions.meta` / `publish(..., {meta})`) **beside** the
validated payload, never inside it:

- **Jobs**: BullMQ job data is always `{$payload, $meta}` (`wrapJobData` /
  `unwrapJobData`, exported). `$payload` is the Zod-validated payload;
  `$meta` is a `Record<string, string>` delivered as `JobContext.meta` /
  `JobInfo.meta` (`{}` when absent). _Pre-release format change:_ earlier
  versions stored the bare payload as job data; on read, a bare payload is
  tolerated (treated as `$payload` with empty meta), but new jobs are always
  written enveloped.
- **Events**: `XADD` writes a `meta` field (JSON) next to the existing
  `payload` and `publishedAt` fields; it is delivered as `MsgMeta.meta`.
  Entries published before the field existed read back as `{}`.

## Testing

Integration tests gate on `REDIS_URL` and skip with a notice when unset:

```bash
pnpm -F @agentback/messaging-bullmq build
REDIS_URL=redis://localhost:6379 pnpm exec vitest run \
  packages/messaging-bullmq/dist/__tests__
```

Each run uses a unique key prefix and deletes its keys afterwards, so it is
safe against a shared local Redis.
