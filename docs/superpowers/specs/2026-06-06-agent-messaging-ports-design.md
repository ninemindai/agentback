# Layer 1 — `@agentback/agent-messaging` Ports

**Date:** 2026-06-06
**Status:** Design spec (ready for implementation plan).
**Parent:** [`2026-06-06-messaging-architecture-map-design.md`](./2026-06-06-messaging-architecture-map-design.md) — Layer 1 of the 5-layer build order.
**Scope:** Ports + typed descriptors + decorators + DI wiring + **in-memory adapter** + shared conformance suite. **No** BullMQ/Redis adapter, **no** engine integration, **no** changes to existing callers (those are Layer 2+).

## Purpose

Replace the loose, BullMQ-leaking `RedisQueueService` shim
(`packages/agent-redis/src/redis-service.ts`, `(...args: any[]): any`) with a
**fully neutral, typed** messaging port layer that the engine, triggers,
delivery, and orchestration can depend on without importing any backend.

This package is the foundation every later layer implements against. It ships a
working **in-memory adapter** so the whole substrate is testable with no Redis,
and a **shared conformance suite** that turns "pluggable transport" from a hope
into an executable contract.

## Decisions (from the Layer-1 brainstorm)

| #   | Decision          | Choice                                                                                                         |
| --- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | Abstraction level | **Fully neutral ports** — BullMQ maps _into_ neutral types; callers never see backend types                    |
| 2   | Port taxonomy     | **A + separate admin** — lean `JobQueue`/`EventBus` flat verb services; ops on a separate `QueueAdmin`         |
| 3   | Registration      | **Imperative primitive + thin decorator** — `process()`/`subscribe()` plus `@jobProcessor`/`@subscriber` sugar |
| 4   | EventBus ack      | **Implicit ack-on-resolve** — resolve acks, throw redelivers; `MsgMeta.deliveryCount` for poison handling      |
| 5   | Naming/typing     | **Typed Zod descriptors** — `defineQueue(name, schema)` / `defineTopic(name, schema)`; validate + infer        |
| 6   | Coexistence       | **Coexist** — standalone package; the old shim + `AgentQueueManager` are untouched until Layer 2               |

## Package

- **Name:** `@agentback/agent-messaging`
- **Deps:** `zod`, `@agentback/core` (for the decorator/DI half only). **Zero backend deps** (no `ioredis`/`bullmq`).
- **Emits:** ports (types), typed descriptors, decorators, DI keys, in-memory adapter, conformance suite.
- **Dependency rule:** consumers → `agent-messaging` (ports) → adapters. `agent-messaging` never depends on an adapter; `agent-redis` (Layer 2) will depend on `agent-messaging`.
- **Standard three-line MIT header** on every file (`Node module: @agentback/agent-messaging`).

## Typed descriptors

The single source of truth: name + schema travel together. `enqueue`/`publish`
validate-and-infer; handlers receive decoded, typed data. Boundary-coherent with
`@get`/`@tool` (see `docs/agent-ergonomics.md`).

```ts
interface QueueDescriptor<T> {
  readonly name: string;
  readonly schema: z.ZodType<T>;
  readonly __kind: 'queue';
}
interface TopicDescriptor<E> {
  readonly name: string;
  readonly schema: z.ZodType<E>;
  readonly __kind: 'topic';
}

function defineQueue<S extends z.ZodType>(
  name: string,
  schema: S,
): QueueDescriptor<z.infer<S>>;
function defineTopic<S extends z.ZodType>(
  name: string,
  schema: S,
): TopicDescriptor<z.infer<S>>;

// example
// export const AGENT_QUEUE = defineQueue('agent-queue', AgentJobSchema)
// export const EXEC_EVENTS = defineTopic('execution.events', ExecutionEventSchema)
```

`__kind` is a discriminant so a descriptor can't be passed to the wrong port by
mistake. Descriptor names are the wire identity (queue/stream key).

## Ports

### `JobQueue` (lean, hot-path audience)

```ts
interface JobQueue {
  enqueue<T>(
    q: QueueDescriptor<T>,
    data: T,
    opts?: EnqueueOptions,
  ): Promise<JobRef>;
  process<T>(
    q: QueueDescriptor<T>,
    handler: (job: JobContext<T>) => Promise<void>,
    opts?: WorkerOptions,
  ): Subscription;
  get<T>(q: QueueDescriptor<T>, id: string): Promise<JobInfo<T> | undefined>;
  cancel(q: QueueDescriptor<unknown>, id: string): Promise<boolean>;
}

interface JobContext<T> {
  readonly id: string;
  readonly data: T; // Zod-decoded
  readonly attempt: number; // 0-based (mirrors BullMQ attemptsMade)
  readonly enqueuedAt: number;
  log(message: string): void;
}

interface EnqueueOptions {
  jobId?: string; // idempotency / dedup key
  delayMs?: number;
  repeat?: RepeatOptions;
  attempts?: number;
  backoff?: {type: 'fixed' | 'exponential'; delayMs: number};
  removeOnComplete?: boolean | {count?: number; ageSecs?: number};
  removeOnFail?: boolean | {count?: number};
  priority?: number;
}
interface RepeatOptions {
  cron?: string;
  everyMs?: number;
  key?: string;
  limit?: number;
}
interface WorkerOptions {
  concurrency?: number;
  lockDurationMs?: number;
  lockRenewMs?: number;
  autorun?: boolean;
}
interface JobRef {
  readonly id: string;
  readonly queue: string;
}
interface JobInfo<T = unknown> {
  readonly id: string;
  readonly state:
    | 'waiting'
    | 'delayed'
    | 'active'
    | 'completed'
    | 'failed'
    | 'unknown';
  readonly data?: T;
  readonly attempt: number;
}
interface Subscription {
  close(): Promise<void>;
}
```

- `cancel`/admin take `QueueDescriptor<unknown>` — identity is all they need; the
  payload type stays where it earns its keep (`enqueue`/`process`/`get`).

### `EventBus` (implicit ack-on-resolve)

```ts
interface EventBus {
  publish<E>(t: TopicDescriptor<E>, event: E): Promise<void>;
  subscribe<E>(
    t: TopicDescriptor<E>,
    group: string,
    handler: (event: E, msg: MsgMeta) => Promise<void>,
    opts?: SubscribeOptions,
  ): Subscription;
}
interface MsgMeta {
  readonly id: string;
  readonly topic: string;
  readonly group: string;
  readonly deliveryCount: number;
  readonly publishedAt: number;
}
interface SubscribeOptions {
  concurrency?: number;
  fromStart?: boolean;
}
```

- Handler resolves → message acked. Handler throws → not acked → redelivered
  (bounded by the adapter). `deliveryCount` lets a subscriber shed poison
  messages. Consumers MUST be idempotent (at-least-once per group).

### `QueueAdmin` (separate; ops/tooling audience; inject `{optional: true}`)

```ts
interface QueueAdmin {
  stats(q: QueueDescriptor<unknown>): Promise<QueueStats>;
  drain(q: QueueDescriptor<unknown>): Promise<void>;
  pause(q: QueueDescriptor<unknown>): Promise<void>;
  resume(q: QueueDescriptor<unknown>): Promise<void>;
  discardStalled(
    q: QueueDescriptor<unknown>,
    olderThanSecs: number,
    opts?: {dryRun?: boolean},
  ): Promise<number>;
}
interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
}
```

Kept off `JobQueue` so the everyday injected contract stays 4 verbs. Hot-path
consumers (engine/triggers/delivery) never see these.

### `Scheduler` (thin helper over `JobQueue`, NOT a backend port)

```ts
interface Scheduler {
  schedule<T>(
    q: QueueDescriptor<T>,
    data: T,
    when: {cron?: string; everyMs?: number; key: string},
  ): Promise<JobRef>;
  unschedule(q: QueueDescriptor<unknown>, key: string): Promise<boolean>;
}
```

Default impl is adapter-agnostic: `schedule` calls `JobQueue.enqueue(q, data, {repeat})`;
`unschedule` removes the repeatable by key. Works over any adapter for free.

## Registration

### Imperative primitive (first-class)

Consumers call `jobQueue.process(...)` / `eventBus.subscribe(...)` from a
`LifeCycleObserver.start()` (the pattern `AgentQueueManager` already uses) and
`close()` the returned `Subscription`s in `stop()`.

### Decorator sugar (over the primitive)

```ts
@jobProcessor(AGENT_QUEUE, {concurrency: 50})
async runAgent(job: JobContext<AgentJob>) { … }

@subscriber(EXEC_EVENTS, 'archive', {fromStart: true})
async archive(event: ExecutionEvent, msg: MsgMeta) { … }
```

- `@bind`-style metadata decorators (same machinery as `@tool`/`@mcpServer`):
  tag the class + stash descriptor/group/options on method metadata.
- A `MessagingBootstrapper` (`LifeCycleObserver`) queries bindings tagged
  `messaging:processor` / `messaging:subscriber` at `start()`, resolves the
  instance, and calls the matching `process()`/`subscribe()` — holding the
  `Subscription`s and `close()`-ing on `stop()`.
- The decorator is **pure sugar**: it emits the exact same primitive calls a
  consumer could write by hand, so both share one code path and the imperative
  form stays first-class (and test-friendly).

## DI wiring

```ts
// keys.ts
const JOB_QUEUE = BindingKey.create<JobQueue>('messaging.JobQueue');
const EVENT_BUS = BindingKey.create<EventBus>('messaging.EventBus');
const QUEUE_ADMIN = BindingKey.create<QueueAdmin>('messaging.QueueAdmin');
const SCHEDULER = BindingKey.create<Scheduler>('messaging.Scheduler');
```

- A `MessagingComponent` binds the chosen adapter to all four keys and registers
  the `MessagingBootstrapper`.
- Hot-path consumers `@inject(JOB_QUEUE)` / `@inject(EVENT_BUS)`; tooling
  `@inject(QUEUE_ADMIN, {optional: true})`.
- The default `Scheduler` is bound by the package itself (adapter-agnostic),
  delegating to whatever `JOB_QUEUE` is bound.

## In-memory adapter

The Layer-1 deliverable that makes the substrate runnable + testable with no Redis.

- **`JobQueue`:** `Map<name, Job[]>`; `process` runs a concurrency-bounded async
  loop; supports `delayMs`, `attempts` + `backoff`, `removeOnComplete/Fail`,
  `jobId` dedup, `get`, `cancel`.
- **`EventBus`:** `Map<topic, entry[]>` with **per-group cursors** (independent
  reader positions), `deliveryCount` increment on redelivery, `fromStart` vs
  new-only. Faithfully reproduces the one Streams semantic consumers depend on:
  independent at-least-once delivery per group.
- **`QueueAdmin`:** stats/drain/pause/resume over the in-memory maps;
  `discardStalled` evicts entries older than the threshold.

### Time fidelity (explicit limitation)

- `delayMs` fires on a real timer.
- **Repeatables** (`everyMs` / cron) are **recorded and validated** on enqueue
  but are NOT fired periodically by the in-memory adapter — a scheduled job
  runs once (subject to `delayMs`). Periodic firing is a Layer-2 (BullMQ)
  concern; `DefaultScheduler.schedule` records repeat intent (verified by test)
  without producing recurring executions in L1.
- `priority` is recorded but not honored for ordering in L1 (FIFO selection);
  priority ordering is a Layer-2 concern. Tests assert scheduling/priority
  _intent_, not wall-clock firing or ordering. **Non-goal for the in-memory double.**

## Serialization + validation contract

- Payloads MUST be JSON-serializable; the descriptor's Zod schema is the gate.
- `enqueue`/`publish`: `schema.parse` on the way in (fail fast at the producer).
- `process`/`subscribe`: `schema.parse` on the way out, before the handler runs.
  A decode failure on consume is a **poison message** → routed to fail /
  redelivery per options, never silently dropped; logged with descriptor name +
  job/msg id.
- Re-asserting the schema on the _consume_ side (not just produce) is deliberate:
  a message can sit across a deploy, so schema validity must be re-checked at
  handle time — catching corruption and schema-drift-across-versions as poison
  rather than as a deep handler crash.

## Testing strategy

- **In-memory adapter is the primary test vehicle** — fast, deterministic, no Redis.
- **Shared conformance suite** exported from `agent-messaging`, asserting the
  contract once:
  - `jobId` idempotency / dedup
  - retry + backoff attempt counting
  - `removeOnComplete` / `removeOnFail`
  - per-group cursor independence (two groups each see all events)
  - `deliveryCount` increments on redelivery
  - decode-failure → poison routing (not handler crash, not silent drop)
  - `cancel` on waiting/delayed
- The in-memory adapter runs the suite in Layer 1; the **BullMQ adapter runs the
  identical suite in Layer 2**. This is how "pluggable" becomes an executable
  contract — any future SQS/NATS adapter has an objective bar to clear.
- Tests live under `packages/agent-messaging/src/__tests__/**` and run against
  built `dist/` per the repo rule (build before test).

## Non-goals (deferred)

- No BullMQ/Redis adapter (Layer 2).
- No changes to `RedisQueueService` / `AgentQueueManager` / any existing caller
  (coexist; migrate in Layer 2).
- No engine integration (`executeDetached`→enqueue, durable `awaitCompletion`) —
  Layer 2.
- No wall-clock cron firing in the in-memory double.
- No periodic repeatable firing (`everyMs`/cron) and no `priority` ordering in
  the in-memory double — recorded + validated only; fired/ordered by the BullMQ
  adapter (Layer 2).
- No BullMQ-specific features surfaced (flows, parent/child, groups) beyond the
  neutral ports; no `QueueAdmin` methods beyond the five listed.

## Risks

- **Neutral-options drift:** if `EnqueueOptions`/`WorkerOptions` omit a field the
  BullMQ adapter later needs, Layer 2 must extend the port (not leak `raw`).
  Mitigation: the conformance suite + keeping options a documented superset of
  the fields current callers (`AgentQueueManager`) actually use.
- **In-memory/Redis semantic gap:** the double could pass while Redis differs.
  Mitigation: the shared conformance suite is the contract; Layer 2 runs the same
  suite against real Redis (testcontainers) before migrating callers.
- **Decorator ↔ core coupling:** pulls `@agentback/core` into the package.
  Accepted — identical to `@tool`'s dependency; the pure-port types remain usable
  without touching the decorator module.

## Downstream (after Layer 1)

Layer 2 (`agent-redis` BullMQ adapter): implement the four ports over
BullMQ + Streams, pass the shared conformance suite against real Redis, then
route `executeDetached` through `JOB_QUEUE` and migrate `AgentQueueManager` off
the old shim — including the durable `awaitCompletion` migration flagged in the
architecture map.
