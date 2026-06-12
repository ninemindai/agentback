# Proposal P0-5: Messaging Layer 2 — BullMQ/Redis Adapter

**Status:** Implemented (2026-06-10); Redis-gated tests in CI need a service container (follow-up).
**Packages touched:** new `messaging-bullmq`; `messaging` (conformance suite reused, minor option-mapping notes).
**Related:** `packages/messaging/README.md` (layer architecture).

## Motivation

FastAPI's `BackgroundTasks` loses jobs on crash (everyone reaches for
Celery); NestJS's queue modules live in a separate typing world from HTTP
DTOs. Layer 1 already nailed the hard part — Zod-typed ports
(`JobQueue`/`EventBus`/`QueueAdmin`/`Scheduler`,
`packages/messaging/src/ports.ts`) plus a conformance suite. Shipping the
durable adapter makes the pitch concrete: _the same Zod schema that validates
the HTTP request types the job payload, the worker gets DI like any
controller, and swapping in-memory → Redis is one component._

## Design

New package `@agentback/messaging-bullmq`:

```ts
import {BullMQMessagingComponent} from '@agentback/messaging-bullmq';

app.component(new BullMQMessagingComponent({connection: {url: REDIS_URL}}));
// rebinds JOB_QUEUE / EVENT_BUS / QUEUE_ADMIN / SCHEDULER
// @jobProcessor / @subscriber classes need zero changes
```

### Port mappings

**`BullMQJobQueue`** — one BullMQ `Queue` per descriptor name (lazily
created, cached, shared `IORedis` connection):

- `enqueue(q, data, opts)` → Zod-parse first (decode failures never reach
  Redis), then `queue.add(q.name, data, mapOptions(opts))`.
  Option mapping: `delayMs→delay`, `attempts→attempts`,
  `backoff→{type:'exponential'|'fixed', delay}`, `jobId` dedup → BullMQ
  `jobId` (its native dedup), `removeOnComplete` (including its `ageSecs`
  form — see `messaging/src/types.ts:22`) → BullMQ `removeOnComplete`.
- `process(q, handler, opts)` → a BullMQ `Worker` with
  `concurrency = opts.concurrency ?? 1`; the handler receives a
  `JobContext<T>` built from the BullMQ job (payload re-validated with the
  descriptor schema on the consumer side — a queue written by an older
  deployment must fail into `failed`, not crash the worker loop; this is the
  conformance suite's decode-failure case). Handler throw → BullMQ retry up
  to `attempts`.
- `get` → `Queue.getJob(id)` mapped to `JobInfo` (state via `job.getState()`).
- `cancel` → `job.remove()` only for waiting/delayed states (parity with
  Layer 1 semantics).

**`RedisStreamsEventBus`** (named for what it is — Redis Streams directly,
`XADD` / `XREADGROUP`-per-`group`, not BullMQ) because consumer groups are
the exact semantic the port promises (per-group cursors, at-least-once,
ack-on-resolve → `XACK`). Pending-entry reclaim (`XAUTOCLAIM`) on a timer
covers crashed consumers.

**Connection discipline (review-corrected):** one shared connection is a
built-in deadlock — BullMQ `Worker`s require `maxRetriesPerRequest: null`
and issue blocking commands, and each `XREADGROUP BLOCK` loop would starve
everything else on the socket. The component holds a base `IORedis`
connection for queues/admin and **duplicates it** per `Worker` and per
event-bus subscription loop (`connection.duplicate()`); all duplicates are
tracked and closed on stop.

**`BullMQQueueAdmin`** — `stats` via `queue.getJobCounts()`; `drain` via
`queue.drain()`; `pause/resume` native; `discardStalled` via scanning
active jobs older than threshold (BullMQ's stalled-checker handles
re-queueing; this API force-fails them).

**`BullMQScheduler`** — BullMQ Job Schedulers (`queue.upsertJobScheduler`)
keyed by `when.key`; `cron` and `everyMs` map directly; `unschedule` →
`removeJobScheduler`.

### Lifecycle

The component registers a lifecycle observer: `stop()` closes workers first
(graceful: `worker.close()` waits for in-flight jobs), then queues, then the
shared connection. `MessagingBootstrapper` already closes subscriptions on
stop — `Subscription.close()` from `process()` maps to `worker.close()`.

### Conformance + CI

- **Suite parametrization (review-corrected):** the current suite is
  timing-coupled to the in-memory adapter (fixed `tick()` windows; the
  `discardStalled` case assumes an active, lock-held job can be removed
  synchronously — BullMQ refuses to remove locked jobs). Step 1 of this
  proposal upgrades `runJobQueueConformance` to accept
  `{settle: () => Promise<void>, capabilities: {syncDiscardActive?: boolean}}`:
  assertions poll-with-timeout (`waitFor`) instead of counting ticks, and
  the active-job `discardStalled` case is gated on the capability (BullMQ
  documents `discardStalled` as force-failing **lock-expired** jobs only).
  The in-memory adapter keeps passing unchanged defaults — the suite change
  is additive.
- The package's test entry runs `runJobQueueConformance('bullmq', factory)`
  and the EventBus conformance against a real Redis.
- Gating: tests **skip with a visible notice** when `REDIS_URL` is unset
  (vitest `describe.skipIf`). CI gains a job with a Redis service container
  so the suite always runs there. No testcontainers dependency — service
  containers keep CI simple and local runs opt-in.
- Known semantic deltas vs in-memory get documented in the README (e.g.
  BullMQ's `jobId` dedup window is permanent-until-removed vs Layer 1's
  seen-set; conformance asserts the contract, not the internals).

### Dependencies

`bullmq` (^5) and `ioredis` (^5) as regular deps of the adapter package only
— the `messaging` core stays dependency-free. pnpm 11 release-age policy
applies; pin one patch back if needed.

## Implementation plan

1. Package scaffold + `BullMQJobQueue` + option mapping + conformance pass.
2. `BullMQEventBus` (streams, groups, ack, reclaim) + conformance pass.
3. Admin + scheduler + lifecycle observer + component.
4. CI: Redis service container job; README with semantics table.
5. Example: extend `hello-hybrid` or add `examples/hello-jobs` showing one
   schema shared by route body and job payload (route enqueues, worker
   processes, `/jobs/:id` reports status).

## Out of scope

- Priorities, flows/parent-child jobs, rate-limited workers — BullMQ supports
  them, but the ports don't promise them yet; widen the ports first
  (separate proposal) rather than leaking BullMQ-isms.
- A second Layer-2 adapter (e.g. pg-boss) — the conformance suite makes this
  cheap later and keeps the ports honest.
