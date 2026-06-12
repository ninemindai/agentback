# Messaging Architecture Map — AgentBack runtime

**Date:** 2026-06-06
**Status:** Architecture map (decomposition doc). Each layer below gets its own spec + plan before implementation.
**Companion diagram:** [`docs/messaging-architecture-map.html`](../../messaging-architecture-map.html)

## Purpose

The agent-runtime needs **async, durable, multi-step work** plus a **foundation for cron-like
jobs**, in both **pub/sub** and **job/worker** styles, on a **distributed/horizontal**
deployment target. This document fixes the boundaries between the layers that deliver
those capabilities so each can be specced and built independently, in order.

This is a map, not a layer spec. It commits the **seams** (ports, dependency direction,
which capability lives where) and deliberately leaves **within-layer** choices to the
per-layer specs.

## Context: what exists today

- **ExecutionEngine + triggers** (`agent-execution-core`): a real state machine with
  `spawn`/`cron`/`message`/`webhook` triggers and parent/child `Execution` records in a
  store. `executeDetached(run)` is fire-and-forget; `awaitCompletion(childId)` is an
  in-memory `Map` of waiters.
- **A queue seam already cut** (`agent-redis` `RedisQueueService` with
  `createQueue`/`createWorker`; `agent-orchestration` declares `agent-queue` and
  `agent-delivery`; worker bodies written; `bullmqAttempt` idempotency field).
  No concrete BullMQ adapter behind it yet.
- **In-process fan-out** already exists: `SinkBatcher` (`agent-execution-core`) routes
  engine step events to multiple sinks with batching modes; `tee-events.ts`
  (`agent-session`) splits the loop event stream (platform adapter + Redis persistence).
- **Redis is currently optional** with an in-memory fallback.

The gap is not "coupling" — it is **durability, survivability, and horizontal scale** of
work that today lives in in-process Promises, and **cross-process** fan-out of events that
today dispatches only in-process.

## Decisions (load-bearing)

| #   | Decision                     | Choice                                                                                                       |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Deployment target            | **Distributed / horizontal** — durability + load-leveling + scale-out all apply                              |
| 2   | Scope of this doc            | **Architecture map first** — define all four layers' boundaries; spec each separately                        |
| 3   | Bus ↔ engine relationship    | **Bus UNDER the engine** — queue is the durable substrate; ExecutionEngine stays the brain                   |
| 4   | Transport dependency policy  | **Pluggable transport, Redis default** — ports + adapters; open to SQS/SNS, NATS later                       |
| 5   | Package home for ports       | **New `@agentback/agent-messaging`** — ports only; orchestration/engine depend on ports                 |
| 6   | Port taxonomy                | **Compare A vs B at job/worker spec time** — A (JobQueue + EventBus + thin Scheduler) is the leaning default |
| 7   | Interactive vs detached path | **In-process for interactive, queue for detached** — two entry points, one engine                            |
| 8   | Pub/sub mechanism            | **Redis Streams + consumer groups** (durable, independent cursors, at-least-once per group)                  |

## The layered model

```
Consumers (ExecutionEngine · Triggers · Delivery · Orchestration)
    │  depend only on ports
    ▼
@agentback/agent-messaging   ← ports, ZERO backend deps
    • JobQueue  : enqueue · consume(worker) · schedule-delayed · repeatable · retries
    • EventBus  : publish · subscribe(consumer-group) · fan-out
    • Scheduler : cron API (thin helper) → repeatable JobQueue jobs (NOT a backend port)
    ▲  implemented by (dependency inversion)
    │
Adapters
    • agent-redis (DEFAULT)  : BullMQ → JobQueue, Streams → EventBus, ioredis
    • in-memory              : dev · test · examples · same contract
    • SQS·SNS / NATS         : FUTURE — same ports, not built

WebSocket gateway = an EventBus subscriber (consumer group) that pushes live status
                    to clients (console live view, Slack). CLIENT EGRESS ONLY.
```

**Dependency rule (the spine):** `consumers → ports → adapters`, never the reverse.
`agent-messaging` has zero backend deps; `agent-redis` depends on `agent-messaging` +
`bullmq`/`ioredis`; the engine depends only on `agent-messaging`.

### Capability → port mapping

| Capability         | Home                                          | Notes                                          |
| ------------------ | --------------------------------------------- | ---------------------------------------------- |
| Durable job/worker | `JobQueue` (BullMQ)                           | exactly-one consumer per job, retries, durable |
| Cron / scheduling  | `Scheduler` → repeatable `JobQueue` jobs      | thin facade, not its own backend seam          |
| Pub/sub fan-out    | `EventBus` (Redis Streams)                    | N readers, consumer groups, durable history    |
| Live status        | WebSocket gateway, a subscriber on `EventBus` | egress only; never a worker bus                |

## The command/fact split (why two ports, not one)

- **`JobQueue` carries commands** — _do this_: one worker should act, with retries and
  durability. Producers expect work to happen exactly once (modulo resumable retries).
- **`EventBus` carries facts** — _this happened_: N readers may care, none obligated.
  No reader can block a producer; each consumer group reads at its own pace.

A single `MessageBus` facade (dapp5 `JobService` style) was rejected: fusing job and
pub/sub semantics produces a god-interface that cannot be implemented partially and
weakens test isolation. dapp5's "re-queue the response as a new job" chaining is also
**not adopted** — the ExecutionEngine is the orchestrator; `EventBus` stays pure
notification.

## Layer 1 — Job/worker substrate (bus under the engine)

**Goal:** make detached execution durable and distributable without rewriting the engine.

1. **Triggers enqueue instead of calling `executeDetached`.** A trigger persists the
   `Execution` record to the store (as today), then `jobQueue.enqueue({executionId})`.
   The payload is **just the id** — the store is the source of truth; the job is a pointer
   - retry envelope.
2. **An `ExecutionWorker` pulls the job and drives the same engine.** It loads the
   `Execution` by id and calls existing `engine.run(run)` / `strategy.run()`. No new
   execution model; the worker is a durable _entry point_ to the state machine. Any
   process with the worker bound can take any job → horizontal scale.
3. **Parent/child completion becomes a durable wait.** On child finish, the worker
   publishes `execution.completed{id}` on `EventBus`; a waiting parent subscribes. On
   crash+resume the parent re-subscribes **and checks the store for already-terminal
   children** to close the "child finished before I subscribed" race. The in-memory
   `Map` remains a fast-path cache, not the source of truth.
4. **Idempotency + resume reuse what exists.** The worker is **resumable, not
   exactly-once**: on a stalled-job retry it reloads the `Execution`, reads its persisted
   step state, and continues from the last committed step. `bullmqAttempt` is the hook.

**Interactive vs detached (Decision 7):** interactive, user-facing turns (synchronous
Slack/REST replies) keep calling the engine **in-process** — no Redis hop, no latency
tax. Only detached/spawn/cron/webhook enqueue. Same engine code; only the entry point
differs. The in-memory `awaitCompletion` Map continues to serve the interactive path.

**Highest-risk edge (flagged for the layer spec):** moving `awaitCompletion` from memory
to a durable subscription, including the subscribe/terminal-state race. This is the one
piece that genuinely changes semantics; everything else is a new entry point to existing
code.

**Port taxonomy decision (Decision 6) is settled here**, comparing:

- **A — `JobQueue` + `EventBus` (+ thin `Scheduler`)** — smallest swappable surface, maps
  1:1 onto BullMQ + Streams. _Leaning default._
- **B — `Queue` + `Worker` + `Topic` + `Scheduler`** — producer/consumer split, scheduler
  as its own backend seam. More named seams, more surface.
- C (single facade) rejected (see command/fact split).

## Layer 2 — Cron / scheduling foundation

- `Scheduler` is a **thin helper over `JobQueue`**, not a backend port. Cron-like tasks =
  **BullMQ repeatable jobs** (durable, dedup'd by repeat key), preferred over the dapp5
  approach (`@loopback/cron` tick polling a scheduled queue).
- The existing `CronTrigger` stays as the in-process **registration API** but enqueues a
  repeatable job instead of firing an in-process timer — so scheduled work is durable and
  survives restart, and fires once across a horizontal fleet.

## Layer 3 — Pub/sub fan-out

- **`EventBus` generalizes the existing in-process fan-out.** `SinkBatcher` and
  `tee-events` become **publishers** on `EventBus`; today's sinks become **subscribers**
  (consumer groups). Batching stays a publisher-side concern; only the delivery mechanism
  changes from in-process dispatch to Redis Streams.
- **Redis Streams + consumer groups** chosen over plain Redis pub/sub (fire-and-forget,
  loses events for down subscribers) and BullMQ's own events (queue-lifecycle, not domain
  events). Streams give durable history (replay/audit preserved), independent subscriber
  cursors, and at-least-once delivery per group.
- Subscriber taxonomy: archive sink · metrics sink · replay capture (existing
  `eventReplay`) · WebSocket gateway — each its own consumer group.
- **Events are facts, not commands.** The same `execution.completed` event drives both a
  waiting parent's completion (Layer 1) and a live UI update (Layer 4). One stream, many
  readers, different intents.

## Layer 4 — Live status (WebSocket)

- The WebSocket gateway is **just another `EventBus` consumer group**. It holds client
  connections (console live view, Slack live updates) and pushes events out.
- **Egress only:** clients receive; they do not drive work through it. Producers never
  know the WebSocket exists. This is why it can be its own later spec without touching
  upstream layers.

## Dependency / transport policy

- **Pluggable, Redis default.** Ports are transport-agnostic. `agent-redis` is the first
  and default adapter (BullMQ + Streams). An **in-memory adapter** ships alongside,
  implementing the same contract for dev, examples, and fast tests. Future adapters
  (SQS/SNS for cross-cloud durability, NATS) implement the same ports.
- Thin payloads + fat store: jobs carry ids/pointers; durable state lives in the store.
  This makes "retry stalled job" and "resume after crash" the same code path.

## Patterns to adopt from dapp5 `components/job` (plumbing, not orchestration)

Adopt: extension-point runner discovery, the `jobHeaders` metadata namespace
(retries/idempotency/timestamps travel beside payload), `LifeCycleObserver` start/stop
wiring, exponential backoff, stalled-job recovery (`discardStaledJobs`).

Do **not** adopt: SQS/SNS dual-queue (dapp5 needs it for multi-service AWS; a single
runtime gets both axes from one Redis), and type-driven job-response **chaining** as the
multi-step model (the ExecutionEngine is the stronger, explicit alternative).

## Non-goals

- No god-interface `MessageBus` facade.
- No SQS/SNS or NATS adapter in the initial build (port boundary stays open to them).
- No routing of interactive turns through the queue.
- No replacement of the ExecutionEngine state machine with queue primitives (the engine
  stays the multi-step brain; the bus sits under it).
- No dapp5-style implicit job-chaining DAG.

## Risks

- **Durable `awaitCompletion` race** (Layer 1) — the subscribe-vs-already-terminal window.
  Highest-risk edge; needs explicit store-check on resume.
- **At-least-once delivery** on `EventBus` means subscribers must be idempotent (e.g.
  metrics double-count guard). Call out per-subscriber.
- **Operational weight of Redis** as a now-load-bearing dependency (monitoring, security,
  memory for Streams retention). Acceptable given the distributed target; the in-memory
  adapter keeps dev/test light.

## Decomposition → downstream specs (build order)

1. **`agent-messaging` ports + in-memory adapter** — define `JobQueue`/`EventBus`/
   `Scheduler` interfaces; settle port taxonomy A vs B; in-memory impl for tests.
2. **`agent-redis` adapter (job/worker)** — BullMQ behind `JobQueue`; wire
   `agent-queue`; route `executeDetached` through it; prove crash-resume on one
   path. Includes the durable `awaitCompletion` migration.
3. **Cron foundation** — `Scheduler` helper + `CronTrigger` enqueues repeatable jobs.
4. **Pub/sub fan-out** — Streams behind `EventBus`; migrate `SinkBatcher`/`tee-events`
   publishers and sink subscribers.
5. **WebSocket gateway** — `EventBus` consumer group → client egress.

Each downstream item is its own brainstorm → spec → plan → implementation cycle.
