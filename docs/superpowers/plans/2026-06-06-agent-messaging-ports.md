# agent-messaging Ports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@agentback/agent-messaging` — fully-neutral, Zod-typed messaging ports (`JobQueue`/`EventBus`/`QueueAdmin`/`Scheduler`), an in-memory adapter, and a shared conformance suite — as a standalone package that touches no existing callers.

**Architecture:** Transport-agnostic port interfaces keyed by typed descriptors (`defineQueue`/`defineTopic` carrying a Zod schema). Registration via an imperative `process()`/`subscribe()` primitive plus thin `@jobProcessor`/`@subscriber` decorators discovered by a `MessagingBootstrapper` lifecycle observer (same machinery as `@tool`). The in-memory adapter is verified by a shared conformance suite that the Layer-2 BullMQ adapter will reuse verbatim.

**Tech Stack:** TypeScript 6 (ESM, `.js` relative imports), Zod v4, `@agentback/core` (DI/metadata/lifecycle), `@agentback/agent-common` (loggers), Vitest (tests compiled to `dist/__tests__` and run from there).

**Spec:** [`docs/superpowers/specs/2026-06-06-agent-messaging-ports-design.md`](../specs/2026-06-06-agent-messaging-ports-design.md)

**Conventions (apply to every file):**

- Three-line MIT header (per CLAUDE.md — NOT other copyright variants):
  ```ts
  // Copyright ninemind.ai 2026. All Rights Reserved.
  // Node module: @agentback/agent-messaging
  // This file is licensed under the MIT License.
  ```
- Relative imports use `.js` extensions. Prettier: single quotes, no bracket spacing (`{foo}`), trailing commas, 80 col.
- **Tests run against built `dist/`** — after editing any `.ts`, run `pnpm -F @agentback/agent-messaging build` before `pnpm exec vitest run`.

---

### Task 1: Scaffold the package

**Files:**

- Create: `packages/agent-messaging/package.json`
- Create: `packages/agent-messaging/tsconfig.json`
- Create: `packages/agent-messaging/src/index.ts`
- Modify: `tsconfig.json` (root references)

- [ ] **Step 1: Create `packages/agent-messaging/package.json`**

```json
{
  "name": "@agentback/agent-messaging",
  "version": "0.0.0",
  "description": "Transport-agnostic messaging ports (JobQueue/EventBus/QueueAdmin/Scheduler) with typed Zod descriptors and an in-memory adapter",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing/conformance.d.ts",
      "import": "./dist/testing/conformance.js"
    }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -b",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@agentback/agent-common": "workspace:*",
    "@agentback/core": "workspace:*",
    "tslib": "^2.8.1",
    "zod": "^4.4.3"
  },
  "engines": {
    "node": ">=22.13"
  }
}
```

- [ ] **Step 2: Create `packages/agent-messaging/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "./tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"],
  "references": [{"path": "../agent-common"}, {"path": "../core"}]
}
```

- [ ] **Step 3: Create `packages/agent-messaging/src/index.ts`** (stub barrel — filled in later tasks)

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

export {};
```

- [ ] **Step 4: Add the package to root `tsconfig.json` references**

In `/Users/rfeng/Projects/ninemind/AgentBack/tsconfig.json`, insert this line into the `references` array immediately after the `{"path": "packages/agent-common"}` entry:

```json
    {"path": "packages/agent-messaging"},
```

- [ ] **Step 5: Install + build to wire the workspace**

Run: `pnpm install && pnpm -F @agentback/agent-messaging build`
Expected: install succeeds (symlinks the new package), build emits `packages/agent-messaging/dist/index.js` with no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-messaging tsconfig.json pnpm-lock.yaml
git commit -m "feat(agent-messaging): scaffold package"
```

---

### Task 2: Typed descriptors (`defineQueue` / `defineTopic`)

**Files:**

- Create: `packages/agent-messaging/src/descriptors.ts`
- Test: `packages/agent-messaging/src/__tests__/unit/descriptors.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-messaging/src/__tests__/unit/descriptors.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {defineQueue, defineTopic} from '../../descriptors.js';

describe('descriptors', () => {
  it('defineQueue carries name, schema, and queue kind', () => {
    const schema = z.object({n: z.number()});
    const q = defineQueue('test.jobs', schema);
    expect(q.name).toBe('test.jobs');
    expect(q.schema).toBe(schema);
    expect(q.__kind).toBe('queue');
  });

  it('defineTopic carries name, schema, and topic kind', () => {
    const schema = z.object({event: z.string()});
    const t = defineTopic('test.events', schema);
    expect(t.name).toBe('test.events');
    expect(t.schema).toBe(schema);
    expect(t.__kind).toBe('topic');
  });

  it('queue schema validates payloads', () => {
    const q = defineQueue('test.jobs', z.object({n: z.number()}));
    expect(() => q.schema.parse({n: 'no'})).toThrow();
    expect(q.schema.parse({n: 1})).toEqual({n: 1});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: FAIL — `Cannot find module '../../descriptors.js'`.

- [ ] **Step 3: Create `packages/agent-messaging/src/descriptors.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import type {z, ZodType} from 'zod';

/** A typed work-queue identity: name + payload schema travel together. */
export interface QueueDescriptor<T> {
  readonly name: string;
  readonly schema: ZodType<T>;
  readonly __kind: 'queue';
}

/** A typed pub/sub topic identity: name + event schema travel together. */
export interface TopicDescriptor<E> {
  readonly name: string;
  readonly schema: ZodType<E>;
  readonly __kind: 'topic';
}

/** Define a queue descriptor. Payload type is inferred from the Zod schema. */
export function defineQueue<S extends ZodType>(
  name: string,
  schema: S,
): QueueDescriptor<z.infer<S>> {
  return {name, schema, __kind: 'queue'};
}

/** Define a topic descriptor. Event type is inferred from the Zod schema. */
export function defineTopic<S extends ZodType>(
  name: string,
  schema: S,
): TopicDescriptor<z.infer<S>> {
  return {name, schema, __kind: 'topic'};
}
```

- [ ] **Step 4: Build and run the test**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/descriptors.unit.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): typed queue/topic descriptors"
```

---

### Task 3: Port value types and interfaces

Type-only files (no runtime) — verified by compilation; exercised by later tasks.

**Files:**

- Create: `packages/agent-messaging/src/types.ts`
- Create: `packages/agent-messaging/src/ports.ts`

- [ ] **Step 1: Create `packages/agent-messaging/src/types.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

/** Repeatable/cron options for an enqueued job. */
export interface RepeatOptions {
  cron?: string;
  everyMs?: number;
  key?: string;
  limit?: number;
}

/** Options controlling how a job is enqueued. */
export interface EnqueueOptions {
  /** Idempotency / dedup key. A repeat enqueue with the same id is a no-op. */
  jobId?: string;
  delayMs?: number;
  repeat?: RepeatOptions;
  /** Max attempts including the first (default 1 = no retry). */
  attempts?: number;
  backoff?: {type: 'fixed' | 'exponential'; delayMs: number};
  removeOnComplete?: boolean | {count?: number; ageSecs?: number};
  removeOnFail?: boolean | {count?: number};
  priority?: number;
}

/** Options for a worker registered via JobQueue.process(). */
export interface WorkerOptions {
  concurrency?: number;
  lockDurationMs?: number;
  lockRenewMs?: number;
  autorun?: boolean;
}

/** The decoded job handed to a processor. */
export interface JobContext<T> {
  readonly id: string;
  readonly data: T;
  /** 0-based redelivery count (mirrors BullMQ attemptsMade). */
  readonly attempt: number;
  readonly enqueuedAt: number;
  log(message: string): void;
}

/** Reference returned by enqueue/schedule. */
export interface JobRef {
  readonly id: string;
  readonly queue: string;
}

/** Snapshot of a job's state. */
export interface JobInfo<T = unknown> {
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

/** A closeable registration (worker or subscriber). */
export interface Subscription {
  close(): Promise<void>;
}

/** Metadata accompanying a delivered event. */
export interface MsgMeta {
  readonly id: string;
  readonly topic: string;
  readonly group: string;
  /** 1-based delivery attempt for this message to this group. */
  readonly deliveryCount: number;
  readonly publishedAt: number;
}

/** Options for an EventBus subscription. */
export interface SubscribeOptions {
  concurrency?: number;
  /** Read history from the start vs only events published after subscribe. */
  fromStart?: boolean;
}

/** Aggregate queue counters. */
export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
}
```

- [ ] **Step 2: Create `packages/agent-messaging/src/ports.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import type {QueueDescriptor, TopicDescriptor} from './descriptors.js';
import type {
  EnqueueOptions,
  JobContext,
  JobInfo,
  JobRef,
  MsgMeta,
  QueueStats,
  Subscription,
  SubscribeOptions,
  WorkerOptions,
} from './types.js';

/** Durable job/worker port (hot-path audience). */
export interface JobQueue {
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

/** Pub/sub fan-out port (implicit ack-on-resolve, at-least-once per group). */
export interface EventBus {
  publish<E>(t: TopicDescriptor<E>, event: E): Promise<void>;
  subscribe<E>(
    t: TopicDescriptor<E>,
    group: string,
    handler: (event: E, msg: MsgMeta) => Promise<void>,
    opts?: SubscribeOptions,
  ): Subscription;
}

/** Operational/maintenance surface (tooling audience; inject optional). */
export interface QueueAdmin {
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

/** Cron/scheduling helper over JobQueue (not a backend port). */
export interface Scheduler {
  schedule<T>(
    q: QueueDescriptor<T>,
    data: T,
    when: {cron?: string; everyMs?: number; key: string},
  ): Promise<JobRef>;
  unschedule(q: QueueDescriptor<unknown>, key: string): Promise<boolean>;
}
```

- [ ] **Step 3: Build to verify it compiles**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: build succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): port value types and interfaces"
```

---

### Task 4: Binding keys, tags, and metadata keys

Constants only — verified by compilation; used by decorators/bootstrapper/component.

**Files:**

- Create: `packages/agent-messaging/src/keys.ts`

- [ ] **Step 1: Create `packages/agent-messaging/src/keys.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {BindingKey} from '@agentback/core';
import type {EventBus, JobQueue, QueueAdmin, Scheduler} from './ports.js';

export const JOB_QUEUE = BindingKey.create<JobQueue>('messaging.JobQueue');
export const EVENT_BUS = BindingKey.create<EventBus>('messaging.EventBus');
export const QUEUE_ADMIN = BindingKey.create<QueueAdmin>(
  'messaging.QueueAdmin',
);
export const SCHEDULER = BindingKey.create<Scheduler>('messaging.Scheduler');

/** Tag marking a binding that has @jobProcessor methods. */
export const MESSAGING_PROCESSOR_TAG = 'messaging:processor';
/** Tag marking a binding that has @subscriber methods. */
export const MESSAGING_SUBSCRIBER_TAG = 'messaging:subscriber';

/** Metadata key for @jobProcessor method metadata. */
export const JOB_PROCESSOR_METADATA_KEY = 'messaging:jobProcessor';
/** Metadata key for @subscriber method metadata. */
export const SUBSCRIBER_METADATA_KEY = 'messaging:subscriber';
```

- [ ] **Step 2: Build to verify**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): binding keys, tags, metadata keys"
```

---

### Task 5: JobQueue conformance suite + in-memory JobQueue

The conformance suite is the behavioral contract; the in-memory adapter is implemented to pass it.

**Files:**

- Create: `packages/agent-messaging/src/testing/conformance.ts`
- Create: `packages/agent-messaging/src/in-memory/in-memory-job-queue.ts`
- Test: `packages/agent-messaging/src/__tests__/unit/in-memory-job-queue.unit.ts`

- [ ] **Step 1: Write the JobQueue conformance suite (the failing spec)**

Create `packages/agent-messaging/src/testing/conformance.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {defineQueue} from '../descriptors.js';
import type {JobQueue} from '../ports.js';

const tick = (ms = 30) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Behavioral contract every JobQueue adapter must satisfy. The in-memory
 * adapter runs this in Layer 1; the BullMQ adapter reuses it verbatim in
 * Layer 2 (imported via `@agentback/agent-messaging/testing`).
 */
export function runJobQueueConformance(
  name: string,
  makeQueue: () => JobQueue,
): void {
  describe(`JobQueue conformance: ${name}`, () => {
    const Q = defineQueue('conformance.jobs', z.object({n: z.number()}));

    it('runs an enqueued job with decoded data', async () => {
      const q = makeQueue();
      const seen: number[] = [];
      const sub = q.process(Q, async job => {
        seen.push(job.data.n);
      });
      await q.enqueue(Q, {n: 7});
      await tick();
      expect(seen).toEqual([7]);
      await sub.close();
    });

    it('dedupes by jobId', async () => {
      const q = makeQueue();
      let count = 0;
      const sub = q.process(Q, async () => {
        count++;
      });
      await q.enqueue(Q, {n: 1}, {jobId: 'dup'});
      await q.enqueue(Q, {n: 1}, {jobId: 'dup'});
      await tick();
      expect(count).toBe(1);
      await sub.close();
    });

    it('retries up to attempts then fails', async () => {
      const q = makeQueue();
      let attempts = 0;
      const sub = q.process(Q, async () => {
        attempts++;
        throw new Error('boom');
      });
      const ref = await q.enqueue(Q, {n: 1}, {attempts: 3});
      await tick(120);
      expect(attempts).toBe(3);
      const info = await q.get(Q, ref.id);
      expect(info?.state).toBe('failed');
      await sub.close();
    });

    it('removeOnComplete removes the finished job', async () => {
      const q = makeQueue();
      const sub = q.process(Q, async () => {});
      const ref = await q.enqueue(Q, {n: 1}, {removeOnComplete: true});
      await tick();
      const info = await q.get(Q, ref.id);
      expect(info).toBeUndefined();
      await sub.close();
    });

    it('cancel removes a waiting (delayed) job before it runs', async () => {
      const q = makeQueue();
      let ran = false;
      const sub = q.process(Q, async () => {
        ran = true;
      });
      const ref = await q.enqueue(Q, {n: 1}, {delayMs: 10_000});
      const cancelled = await q.cancel(Q, ref.id);
      expect(cancelled).toBe(true);
      await tick();
      expect(ran).toBe(false);
      await sub.close();
    });

    it('routes a decode failure to failed (poison), not a silent drop', async () => {
      const q = makeQueue();
      // Bypass producer-side validation to simulate corrupt/drifted payload.
      const Bad = {...Q, schema: z.any()} as typeof Q;
      let handlerRan = false;
      const sub = q.process(Q, async () => {
        handlerRan = true;
      });
      const ref = await q.enqueue(Bad, {wrong: true} as never, {attempts: 1});
      await tick();
      expect(handlerRan).toBe(false);
      const info = await q.get(Q, ref.id);
      expect(info?.state).toBe('failed');
      await sub.close();
    });
  });
}
```

- [ ] **Step 2: Write the in-memory test that invokes the suite**

Create `packages/agent-messaging/src/__tests__/unit/in-memory-job-queue.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {runJobQueueConformance} from '../../testing/conformance.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';

runJobQueueConformance('in-memory', () => new InMemoryJobQueue());
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: FAIL — `Cannot find module '../../in-memory/in-memory-job-queue.js'`.

- [ ] **Step 4: Implement `packages/agent-messaging/src/in-memory/in-memory-job-queue.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {loggers} from '@agentback/agent-common';
import type {QueueDescriptor} from '../descriptors.js';
import type {JobQueue} from '../ports.js';
import type {
  EnqueueOptions,
  JobContext,
  JobInfo,
  JobRef,
  Subscription,
  WorkerOptions,
} from '../types.js';

const {error: logError} = loggers('messaging:in-memory:job-queue');

type JobState = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed';

interface StoredJob {
  id: string;
  queue: string;
  raw: unknown;
  attempt: number;
  state: JobState;
  availableAt: number;
  enqueuedAt: number;
  opts: EnqueueOptions;
}

function backoffDelay(
  backoff: EnqueueOptions['backoff'],
  attempt: number,
): number {
  if (!backoff) return 0;
  if (backoff.type === 'exponential') {
    return backoff.delayMs * Math.pow(2, attempt - 1);
  }
  return backoff.delayMs;
}

/** In-memory JobQueue adapter. Faithful enough to run the conformance suite. */
export class InMemoryJobQueue implements JobQueue {
  private counter = 0;
  private jobs = new Map<string, StoredJob[]>();
  private byId = new Map<string, StoredJob>();
  private seenJobIds = new Set<string>();
  private wakers = new Map<string, () => void>();

  private nextId(): string {
    return `job_${++this.counter}`;
  }

  private list(name: string): StoredJob[] {
    let l = this.jobs.get(name);
    if (!l) {
      l = [];
      this.jobs.set(name, l);
    }
    return l;
  }

  private remove(name: string, id: string): void {
    const l = this.jobs.get(name);
    if (l)
      this.jobs.set(
        name,
        l.filter(j => j.id !== id),
      );
    this.byId.delete(id);
  }

  async enqueue<T>(
    q: QueueDescriptor<T>,
    data: T,
    opts: EnqueueOptions = {},
  ): Promise<JobRef> {
    const parsed = q.schema.parse(data);
    if (opts.jobId && this.seenJobIds.has(opts.jobId)) {
      return {id: opts.jobId, queue: q.name};
    }
    const id = opts.jobId ?? this.nextId();
    if (opts.jobId) this.seenJobIds.add(opts.jobId);
    const now = Date.now();
    const job: StoredJob = {
      id,
      queue: q.name,
      raw: parsed,
      attempt: 0,
      state: opts.delayMs ? 'delayed' : 'waiting',
      availableAt: now + (opts.delayMs ?? 0),
      enqueuedAt: now,
      opts,
    };
    this.list(q.name).push(job);
    this.byId.set(id, job);
    this.wakers.get(q.name)?.();
    return {id, queue: q.name};
  }

  process<T>(
    q: QueueDescriptor<T>,
    handler: (job: JobContext<T>) => Promise<void>,
    opts: WorkerOptions = {},
  ): Subscription {
    const concurrency = opts.concurrency ?? 1;
    let closed = false;
    let active = 0;
    let wake: (() => void) | undefined;
    this.wakers.set(q.name, () => wake?.());

    const runOne = (job: StoredJob): void => {
      job.state = 'active';
      active++;
      void (async () => {
        try {
          const data = q.schema.parse(job.raw) as T;
          const ctx: JobContext<T> = {
            id: job.id,
            data,
            attempt: job.attempt,
            enqueuedAt: job.enqueuedAt,
            log: () => {},
          };
          await handler(ctx);
          job.state = 'completed';
          if (job.opts.removeOnComplete !== false) {
            if (
              job.opts.removeOnComplete === true ||
              job.opts.removeOnComplete === undefined
            ) {
              this.remove(q.name, job.id);
            }
          }
        } catch (err) {
          job.attempt++;
          const max = job.opts.attempts ?? 1;
          if (job.attempt < max) {
            job.availableAt =
              Date.now() + backoffDelay(job.opts.backoff, job.attempt);
            job.state = 'waiting';
          } else {
            job.state = 'failed';
            logError('job %s failed permanently: %O', job.id, err);
            if (job.opts.removeOnFail === true) this.remove(q.name, job.id);
          }
        } finally {
          active--;
          wake?.();
        }
      })();
    };

    const pump = async (): Promise<void> => {
      while (!closed) {
        const now = Date.now();
        const ready = this.list(q.name).find(
          j =>
            (j.state === 'waiting' || j.state === 'delayed') &&
            j.availableAt <= now,
        );
        if (ready && active < concurrency) {
          runOne(ready);
          continue;
        }
        await new Promise<void>(res => {
          wake = res;
          setTimeout(res, 10);
        });
      }
    };
    void pump();

    return {
      close: async () => {
        closed = true;
        this.wakers.delete(q.name);
        wake?.();
      },
    };
  }

  async get<T>(
    q: QueueDescriptor<T>,
    id: string,
  ): Promise<JobInfo<T> | undefined> {
    const job = this.byId.get(id);
    if (!job || job.queue !== q.name) return undefined;
    return {
      id: job.id,
      state: job.state,
      data: job.raw as T,
      attempt: job.attempt,
    };
  }

  async cancel(q: QueueDescriptor<unknown>, id: string): Promise<boolean> {
    const job = this.byId.get(id);
    if (!job || job.queue !== q.name) return false;
    if (job.state === 'waiting' || job.state === 'delayed') {
      this.remove(q.name, id);
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 5: Build and run the conformance test**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/in-memory-job-queue.unit.js`
Expected: PASS (6 conformance tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): JobQueue conformance suite + in-memory adapter"
```

---

### Task 6: EventBus conformance + in-memory EventBus

**Files:**

- Modify: `packages/agent-messaging/src/testing/conformance.ts` (add `runEventBusConformance`)
- Create: `packages/agent-messaging/src/in-memory/in-memory-event-bus.ts`
- Test: `packages/agent-messaging/src/__tests__/unit/in-memory-event-bus.unit.ts`

- [ ] **Step 1: Append the EventBus conformance suite**

Add to `packages/agent-messaging/src/testing/conformance.ts`. First extend the imports at the top:

```ts
import {defineQueue, defineTopic} from '../descriptors.js';
import type {EventBus, JobQueue} from '../ports.js';
```

Then append this function at the end of the file:

```ts
/** Behavioral contract every EventBus adapter must satisfy. */
export function runEventBusConformance(
  name: string,
  makeBus: () => EventBus,
): void {
  describe(`EventBus conformance: ${name}`, () => {
    const T = defineTopic('conformance.events', z.object({v: z.number()}));

    it('delivers a published event to a subscriber, decoded', async () => {
      const bus = makeBus();
      const got: number[] = [];
      const sub = bus.subscribe(T, 'g1', async e => {
        got.push(e.v);
      });
      await tick();
      await bus.publish(T, {v: 5});
      await tick();
      expect(got).toEqual([5]);
      await sub.close();
    });

    it('fans out to independent groups (each group sees all events)', async () => {
      const bus = makeBus();
      const a: number[] = [];
      const b: number[] = [];
      const subA = bus.subscribe(T, 'A', async e => {
        a.push(e.v);
      });
      const subB = bus.subscribe(T, 'B', async e => {
        b.push(e.v);
      });
      await tick();
      await bus.publish(T, {v: 1});
      await bus.publish(T, {v: 2});
      await tick();
      expect(a).toEqual([1, 2]);
      expect(b).toEqual([1, 2]);
      await subA.close();
      await subB.close();
    });

    it('increments deliveryCount on redelivery after a throw', async () => {
      const bus = makeBus();
      const counts: number[] = [];
      let fail = true;
      const sub = bus.subscribe(T, 'g', async (_e, msg) => {
        counts.push(msg.deliveryCount);
        if (fail) {
          fail = false;
          throw new Error('retry me');
        }
      });
      await tick();
      await bus.publish(T, {v: 9});
      await tick(120);
      expect(counts[0]).toBe(1);
      expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(2);
      await sub.close();
    });

    it('fromStart replays history; default reads only new events', async () => {
      const bus = makeBus();
      await bus.publish(T, {v: 100});
      await tick();
      const replayed: number[] = [];
      const sub = bus.subscribe(
        T,
        'late',
        async e => {
          replayed.push(e.v);
        },
        {fromStart: true},
      );
      await tick();
      expect(replayed).toEqual([100]);
      await sub.close();
    });
  });
}
```

- [ ] **Step 2: Write the in-memory EventBus test**

Create `packages/agent-messaging/src/__tests__/unit/in-memory-event-bus.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {runEventBusConformance} from '../../testing/conformance.js';
import {InMemoryEventBus} from '../../in-memory/in-memory-event-bus.js';

runEventBusConformance('in-memory', () => new InMemoryEventBus());
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: FAIL — `Cannot find module '../../in-memory/in-memory-event-bus.js'`.

- [ ] **Step 4: Implement `packages/agent-messaging/src/in-memory/in-memory-event-bus.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {loggers} from '@agentback/agent-common';
import type {TopicDescriptor} from '../descriptors.js';
import type {EventBus} from '../ports.js';
import type {MsgMeta, Subscription, SubscribeOptions} from '../types.js';

const {error: logError} = loggers('messaging:in-memory:event-bus');

interface Entry {
  id: string;
  raw: unknown;
  publishedAt: number;
}

/** In-memory EventBus adapter with per-group cursors + redelivery. */
export class InMemoryEventBus implements EventBus {
  private counter = 0;
  private log = new Map<string, Entry[]>();
  private wakers = new Set<() => void>();

  private entries(topic: string): Entry[] {
    let l = this.log.get(topic);
    if (!l) {
      l = [];
      this.log.set(topic, l);
    }
    return l;
  }

  async publish<E>(t: TopicDescriptor<E>, event: E): Promise<void> {
    const parsed = t.schema.parse(event);
    this.entries(t.name).push({
      id: `evt_${++this.counter}`,
      raw: parsed,
      publishedAt: Date.now(),
    });
    for (const w of this.wakers) w();
  }

  subscribe<E>(
    t: TopicDescriptor<E>,
    group: string,
    handler: (event: E, msg: MsgMeta) => Promise<void>,
    opts: SubscribeOptions = {},
  ): Subscription {
    let closed = false;
    // Cursor: index into the topic log. fromStart → 0, else end (new only).
    let cursor = opts.fromStart ? 0 : this.entries(t.name).length;
    let wake: (() => void) | undefined;
    const waker = () => wake?.();
    this.wakers.add(waker);

    const pump = async (): Promise<void> => {
      while (!closed) {
        const entries = this.entries(t.name);
        if (cursor < entries.length) {
          const entry = entries[cursor];
          let delivery = 0;
          // Redeliver until the handler resolves (implicit ack-on-resolve).
          // Bounded loop guards against an always-throwing handler.
          let acked = false;
          while (!closed && !acked && delivery < 50) {
            delivery++;
            try {
              const data = t.schema.parse(entry.raw) as E;
              const msg: MsgMeta = {
                id: entry.id,
                topic: t.name,
                group,
                deliveryCount: delivery,
                publishedAt: entry.publishedAt,
              };
              await handler(data, msg);
              acked = true;
            } catch (err) {
              logError(
                'event %s redeliver %d to group %s: %O',
                entry.id,
                delivery,
                group,
                err,
              );
              await new Promise<void>(r => setTimeout(r, 20));
            }
          }
          cursor++;
          continue;
        }
        await new Promise<void>(res => {
          wake = res;
          setTimeout(res, 10);
        });
      }
    };
    void pump();

    return {
      close: async () => {
        closed = true;
        this.wakers.delete(waker);
        wake?.();
      },
    };
  }
}
```

- [ ] **Step 5: Build and run the test**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/in-memory-event-bus.unit.js`
Expected: PASS (4 conformance tests).

- [ ] **Step 6: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): EventBus conformance suite + in-memory adapter"
```

---

### Task 7: QueueAdmin conformance + in-memory QueueAdmin

The in-memory admin operates over the same store as `InMemoryJobQueue`, so they share a backing store object.

**Files:**

- Modify: `packages/agent-messaging/src/in-memory/in-memory-job-queue.ts` (extract a shared store)
- Create: `packages/agent-messaging/src/in-memory/in-memory-store.ts`
- Create: `packages/agent-messaging/src/in-memory/in-memory-queue-admin.ts`
- Modify: `packages/agent-messaging/src/testing/conformance.ts` (add `runQueueAdminConformance`)
- Test: `packages/agent-messaging/src/__tests__/unit/in-memory-queue-admin.unit.ts`

- [ ] **Step 1: Extract the shared store**

Create `packages/agent-messaging/src/in-memory/in-memory-store.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import type {EnqueueOptions} from '../types.js';

export type JobState =
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'completed'
  | 'failed';

export interface StoredJob {
  id: string;
  queue: string;
  raw: unknown;
  attempt: number;
  state: JobState;
  availableAt: number;
  enqueuedAt: number;
  opts: EnqueueOptions;
}

/** Shared mutable store so JobQueue and QueueAdmin see the same jobs. */
export class InMemoryStore {
  counter = 0;
  jobs = new Map<string, StoredJob[]>();
  byId = new Map<string, StoredJob>();
  seenJobIds = new Set<string>();
  paused = new Set<string>();

  list(name: string): StoredJob[] {
    let l = this.jobs.get(name);
    if (!l) {
      l = [];
      this.jobs.set(name, l);
    }
    return l;
  }

  remove(name: string, id: string): void {
    const l = this.jobs.get(name);
    if (l)
      this.jobs.set(
        name,
        l.filter(j => j.id !== id),
      );
    this.byId.delete(id);
  }
}
```

- [ ] **Step 2: Rewrite `in-memory-job-queue.ts` to use the shared store**

Replace the full contents of `packages/agent-messaging/src/in-memory/in-memory-job-queue.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {loggers} from '@agentback/agent-common';
import type {QueueDescriptor} from '../descriptors.js';
import type {JobQueue} from '../ports.js';
import type {
  EnqueueOptions,
  JobContext,
  JobInfo,
  JobRef,
  Subscription,
  WorkerOptions,
} from '../types.js';
import {InMemoryStore, type StoredJob} from './in-memory-store.js';

const {error: logError} = loggers('messaging:in-memory:job-queue');

function backoffDelay(
  backoff: EnqueueOptions['backoff'],
  attempt: number,
): number {
  if (!backoff) return 0;
  if (backoff.type === 'exponential') {
    return backoff.delayMs * Math.pow(2, attempt - 1);
  }
  return backoff.delayMs;
}

/** In-memory JobQueue adapter. Shares its store with InMemoryQueueAdmin. */
export class InMemoryJobQueue implements JobQueue {
  constructor(private store: InMemoryStore = new InMemoryStore()) {}

  /** Expose the store so a paired admin can be built over the same jobs. */
  get backingStore(): InMemoryStore {
    return this.store;
  }

  private wakers = new Map<string, () => void>();

  async enqueue<T>(
    q: QueueDescriptor<T>,
    data: T,
    opts: EnqueueOptions = {},
  ): Promise<JobRef> {
    const parsed = q.schema.parse(data);
    if (opts.jobId && this.store.seenJobIds.has(opts.jobId)) {
      return {id: opts.jobId, queue: q.name};
    }
    const id = opts.jobId ?? `job_${++this.store.counter}`;
    if (opts.jobId) this.store.seenJobIds.add(opts.jobId);
    const now = Date.now();
    const job: StoredJob = {
      id,
      queue: q.name,
      raw: parsed,
      attempt: 0,
      state: opts.delayMs ? 'delayed' : 'waiting',
      availableAt: now + (opts.delayMs ?? 0),
      enqueuedAt: now,
      opts,
    };
    this.store.list(q.name).push(job);
    this.store.byId.set(id, job);
    this.wakers.get(q.name)?.();
    return {id, queue: q.name};
  }

  process<T>(
    q: QueueDescriptor<T>,
    handler: (job: JobContext<T>) => Promise<void>,
    opts: WorkerOptions = {},
  ): Subscription {
    const concurrency = opts.concurrency ?? 1;
    let closed = false;
    let active = 0;
    let wake: (() => void) | undefined;
    this.wakers.set(q.name, () => wake?.());

    const runOne = (job: StoredJob): void => {
      job.state = 'active';
      active++;
      void (async () => {
        try {
          const data = q.schema.parse(job.raw) as T;
          await handler({
            id: job.id,
            data,
            attempt: job.attempt,
            enqueuedAt: job.enqueuedAt,
            log: () => {},
          });
          job.state = 'completed';
          if (
            job.opts.removeOnComplete === true ||
            job.opts.removeOnComplete === undefined
          ) {
            this.store.remove(q.name, job.id);
          }
        } catch (err) {
          job.attempt++;
          const max = job.opts.attempts ?? 1;
          if (job.attempt < max) {
            job.availableAt =
              Date.now() + backoffDelay(job.opts.backoff, job.attempt);
            job.state = 'waiting';
          } else {
            job.state = 'failed';
            logError('job %s failed permanently: %O', job.id, err);
            if (job.opts.removeOnFail === true)
              this.store.remove(q.name, job.id);
          }
        } finally {
          active--;
          wake?.();
        }
      })();
    };

    const pump = async (): Promise<void> => {
      while (!closed) {
        const now = Date.now();
        const ready = this.store
          .list(q.name)
          .find(
            j =>
              !this.store.paused.has(q.name) &&
              (j.state === 'waiting' || j.state === 'delayed') &&
              j.availableAt <= now,
          );
        if (ready && active < concurrency) {
          runOne(ready);
          continue;
        }
        await new Promise<void>(res => {
          wake = res;
          setTimeout(res, 10);
        });
      }
    };
    void pump();

    return {
      close: async () => {
        closed = true;
        this.wakers.delete(q.name);
        wake?.();
      },
    };
  }

  async get<T>(
    q: QueueDescriptor<T>,
    id: string,
  ): Promise<JobInfo<T> | undefined> {
    const job = this.store.byId.get(id);
    if (!job || job.queue !== q.name) return undefined;
    return {
      id: job.id,
      state: job.state,
      data: job.raw as T,
      attempt: job.attempt,
    };
  }

  async cancel(q: QueueDescriptor<unknown>, id: string): Promise<boolean> {
    const job = this.store.byId.get(id);
    if (!job || job.queue !== q.name) return false;
    if (job.state === 'waiting' || job.state === 'delayed') {
      this.store.remove(q.name, id);
      return true;
    }
    return false;
  }
}
```

- [ ] **Step 3: Append the QueueAdmin conformance suite**

Add to the imports in `packages/agent-messaging/src/testing/conformance.ts`:

```ts
import type {EventBus, JobQueue, QueueAdmin} from '../ports.js';
```

Append at the end of the file:

```ts
/**
 * Behavioral contract for QueueAdmin. `makePair` returns an admin plus a way
 * to enqueue into the same backing store, so the suite stays adapter-neutral.
 */
export function runQueueAdminConformance(
  name: string,
  makePair: () => {
    admin: QueueAdmin;
    queue: JobQueue;
  },
): void {
  describe(`QueueAdmin conformance: ${name}`, () => {
    const Q = defineQueue('conformance.admin', z.object({n: z.number()}));

    it('reports waiting count in stats', async () => {
      const {admin, queue} = makePair();
      await queue.enqueue(Q, {n: 1});
      await queue.enqueue(Q, {n: 2});
      const stats = await admin.stats(Q);
      expect(stats.waiting).toBe(2);
    });

    it('drain clears the queue', async () => {
      const {admin, queue} = makePair();
      await queue.enqueue(Q, {n: 1});
      await admin.drain(Q);
      const stats = await admin.stats(Q);
      expect(stats.waiting).toBe(0);
    });

    it('pause stops processing; resume restarts it', async () => {
      const {admin, queue} = makePair();
      const ran: number[] = [];
      await admin.pause(Q);
      const sub = queue.process(Q, async job => {
        ran.push(job.data.n);
      });
      await queue.enqueue(Q, {n: 7});
      await tick();
      expect(ran).toEqual([]);
      await admin.resume(Q);
      await tick();
      expect(ran).toEqual([7]);
      await sub.close();
    });
  });
}
```

- [ ] **Step 4: Implement `packages/agent-messaging/src/in-memory/in-memory-queue-admin.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import type {QueueDescriptor} from '../descriptors.js';
import type {QueueAdmin} from '../ports.js';
import type {QueueStats} from '../types.js';
import type {InMemoryStore} from './in-memory-store.js';

/** In-memory QueueAdmin over a shared InMemoryStore. */
export class InMemoryQueueAdmin implements QueueAdmin {
  constructor(private store: InMemoryStore) {}

  async stats(q: QueueDescriptor<unknown>): Promise<QueueStats> {
    const jobs = this.store.list(q.name);
    const count = (s: string) => jobs.filter(j => j.state === s).length;
    return {
      waiting: count('waiting'),
      active: count('active'),
      delayed: count('delayed'),
      completed: count('completed'),
      failed: count('failed'),
    };
  }

  async drain(q: QueueDescriptor<unknown>): Promise<void> {
    for (const j of [...this.store.list(q.name)]) {
      if (j.state === 'waiting' || j.state === 'delayed') {
        this.store.remove(q.name, j.id);
      }
    }
  }

  async pause(q: QueueDescriptor<unknown>): Promise<void> {
    this.store.paused.add(q.name);
  }

  async resume(q: QueueDescriptor<unknown>): Promise<void> {
    this.store.paused.delete(q.name);
  }

  async discardStalled(
    q: QueueDescriptor<unknown>,
    olderThanSecs: number,
    opts: {dryRun?: boolean} = {},
  ): Promise<number> {
    const cutoff = Date.now() - olderThanSecs * 1000;
    const stalled = this.store
      .list(q.name)
      .filter(j => j.state === 'active' && j.enqueuedAt < cutoff);
    if (!opts.dryRun) {
      for (const j of stalled) this.store.remove(q.name, j.id);
    }
    return stalled.length;
  }
}
```

- [ ] **Step 5: Write the in-memory admin test**

Create `packages/agent-messaging/src/__tests__/unit/in-memory-queue-admin.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {runQueueAdminConformance} from '../../testing/conformance.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';
import {InMemoryQueueAdmin} from '../../in-memory/in-memory-queue-admin.js';

runQueueAdminConformance('in-memory', () => {
  const queue = new InMemoryJobQueue();
  const admin = new InMemoryQueueAdmin(queue.backingStore);
  return {admin, queue};
});
```

- [ ] **Step 6: Build and run all in-memory tests**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/`
Expected: PASS — JobQueue (6) + EventBus (4) + QueueAdmin (3) all green.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): QueueAdmin conformance + shared in-memory store"
```

---

### Task 8: Default Scheduler

**Files:**

- Create: `packages/agent-messaging/src/scheduler.ts`
- Test: `packages/agent-messaging/src/__tests__/unit/scheduler.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-messaging/src/__tests__/unit/scheduler.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {defineQueue} from '../../descriptors.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';
import {DefaultScheduler} from '../../scheduler.js';
import type {EnqueueOptions} from '../../types.js';
import type {QueueDescriptor} from '../../descriptors.js';

describe('DefaultScheduler', () => {
  const Q = defineQueue('sched.jobs', z.object({n: z.number()}));

  it('schedule() enqueues with a repeat option carrying the key', async () => {
    const calls: EnqueueOptions[] = [];
    const queue = new InMemoryJobQueue();
    const spy = {
      ...queue,
      enqueue: async (
        q: QueueDescriptor<unknown>,
        data: unknown,
        opts?: EnqueueOptions,
      ) => {
        if (opts) calls.push(opts);
        return {id: 'x', queue: q.name};
      },
    };
    const scheduler = new DefaultScheduler(spy as unknown as InMemoryJobQueue);
    await scheduler.schedule(Q, {n: 1}, {cron: '*/5 * * * *', key: 'k1'});
    expect(calls[0].repeat).toEqual({cron: '*/5 * * * *', key: 'k1'});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: FAIL — `Cannot find module '../../scheduler.js'`.

- [ ] **Step 3: Implement `packages/agent-messaging/src/scheduler.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import type {QueueDescriptor} from './descriptors.js';
import type {JobQueue, Scheduler} from './ports.js';
import type {JobRef} from './types.js';

/**
 * Adapter-agnostic Scheduler: cron/interval scheduling is expressed as a
 * repeatable JobQueue job. Works over any JobQueue adapter.
 */
export class DefaultScheduler implements Scheduler {
  constructor(private queue: JobQueue) {}

  async schedule<T>(
    q: QueueDescriptor<T>,
    data: T,
    when: {cron?: string; everyMs?: number; key: string},
  ): Promise<JobRef> {
    return this.queue.enqueue(q, data, {
      jobId: `repeat:${q.name}:${when.key}`,
      repeat: {cron: when.cron, everyMs: when.everyMs, key: when.key},
    });
  }

  async unschedule(q: QueueDescriptor<unknown>, key: string): Promise<boolean> {
    return this.queue.cancel(q, `repeat:${q.name}:${key}`);
  }
}
```

- [ ] **Step 4: Build and run the test**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/scheduler.unit.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): adapter-agnostic DefaultScheduler"
```

---

### Task 9: `@jobProcessor` / `@subscriber` decorators

**Files:**

- Create: `packages/agent-messaging/src/decorators.ts`
- Test: `packages/agent-messaging/src/__tests__/unit/decorators.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-messaging/src/__tests__/unit/decorators.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {MetadataInspector} from '@agentback/metadata';
import {defineQueue, defineTopic} from '../../descriptors.js';
import {jobProcessor, subscriber} from '../../decorators.js';
import {
  JOB_PROCESSOR_METADATA_KEY,
  SUBSCRIBER_METADATA_KEY,
} from '../../keys.js';
import type {
  JobProcessorMetadata,
  SubscriberMetadata,
} from '../../decorators.js';

const Q = defineQueue('dec.jobs', z.object({n: z.number()}));
const T = defineTopic('dec.events', z.object({v: z.number()}));

describe('messaging decorators', () => {
  it('@jobProcessor stores descriptor + options on method metadata', () => {
    class W {
      @jobProcessor(Q, {concurrency: 4})
      run() {}
    }
    const meta = MetadataInspector.getAllMethodMetadata<JobProcessorMetadata>(
      JOB_PROCESSOR_METADATA_KEY,
      W.prototype,
    );
    expect(meta?.run.queueName).toBe('dec.jobs');
    expect(meta?.run.options?.concurrency).toBe(4);
  });

  it('@subscriber stores topic + group on method metadata', () => {
    class S {
      @subscriber(T, 'archive', {fromStart: true})
      on() {}
    }
    const meta = MetadataInspector.getAllMethodMetadata<SubscriberMetadata>(
      SUBSCRIBER_METADATA_KEY,
      S.prototype,
    );
    expect(meta?.on.topicName).toBe('dec.events');
    expect(meta?.on.group).toBe('archive');
    expect(meta?.on.options?.fromStart).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: FAIL — `Cannot find module '../../decorators.js'`.

- [ ] **Step 3: Implement `packages/agent-messaging/src/decorators.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {MethodDecoratorFactory} from '@agentback/metadata';
import type {QueueDescriptor, TopicDescriptor} from './descriptors.js';
import {JOB_PROCESSOR_METADATA_KEY, SUBSCRIBER_METADATA_KEY} from './keys.js';
import type {SubscribeOptions, WorkerOptions} from './types.js';

/** Metadata stored by @jobProcessor (descriptor kept for schema decoding). */
export interface JobProcessorMetadata {
  queueName: string;
  descriptor: QueueDescriptor<unknown>;
  options?: WorkerOptions;
  methodName: string;
}

/** Metadata stored by @subscriber. */
export interface SubscriberMetadata {
  topicName: string;
  descriptor: TopicDescriptor<unknown>;
  group: string;
  options?: SubscribeOptions;
  methodName: string;
}

/** Register a method as a JobQueue processor for `q`. */
export function jobProcessor<T>(
  q: QueueDescriptor<T>,
  options?: WorkerOptions,
): MethodDecorator {
  return function (target, methodName, descriptor) {
    const meta: JobProcessorMetadata = {
      queueName: q.name,
      descriptor: q as QueueDescriptor<unknown>,
      options,
      methodName: methodName as string,
    };
    MethodDecoratorFactory.createDecorator<JobProcessorMetadata>(
      JOB_PROCESSOR_METADATA_KEY,
      meta,
      {decoratorName: '@jobProcessor'},
    )(target, methodName, descriptor);
  };
}

/** Register a method as an EventBus subscriber on `t` for `group`. */
export function subscriber<E>(
  t: TopicDescriptor<E>,
  group: string,
  options?: SubscribeOptions,
): MethodDecorator {
  return function (target, methodName, descriptor) {
    const meta: SubscriberMetadata = {
      topicName: t.name,
      descriptor: t as TopicDescriptor<unknown>,
      group,
      options,
      methodName: methodName as string,
    };
    MethodDecoratorFactory.createDecorator<SubscriberMetadata>(
      SUBSCRIBER_METADATA_KEY,
      meta,
      {decoratorName: '@subscriber'},
    )(target, methodName, descriptor);
  };
}
```

- [ ] **Step 4: Build and run the test**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/decorators.unit.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): @jobProcessor and @subscriber decorators"
```

---

### Task 10: `MessagingBootstrapper` (decorator discovery)

Discovers classes tagged `messaging:processor`/`messaging:subscriber`, reads method metadata, and wires `process()`/`subscribe()` at `start()`.

**Files:**

- Create: `packages/agent-messaging/src/bootstrapper.ts`
- Test: `packages/agent-messaging/src/__tests__/unit/bootstrapper.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-messaging/src/__tests__/unit/bootstrapper.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {describe, it, expect, beforeEach} from 'vitest';
import {z} from 'zod';
import {Context} from '@agentback/context';
import {defineQueue} from '../../descriptors.js';
import {jobProcessor} from '../../decorators.js';
import {InMemoryJobQueue} from '../../in-memory/in-memory-job-queue.js';
import {InMemoryEventBus} from '../../in-memory/in-memory-event-bus.js';
import {MessagingBootstrapper} from '../../bootstrapper.js';
import {EVENT_BUS, JOB_QUEUE, MESSAGING_PROCESSOR_TAG} from '../../keys.js';

const Q = defineQueue('boot.jobs', z.object({n: z.number()}));
const tick = (ms = 30) => new Promise<void>(r => setTimeout(r, ms));

describe('MessagingBootstrapper', () => {
  let ctx: Context;
  let queue: InMemoryJobQueue;

  beforeEach(() => {
    ctx = new Context('test');
    queue = new InMemoryJobQueue();
    ctx.bind(JOB_QUEUE).to(queue);
    ctx.bind(EVENT_BUS).to(new InMemoryEventBus());
  });

  it('wires a @jobProcessor method to the queue at start()', async () => {
    const seen: number[] = [];
    class Worker {
      @jobProcessor(Q)
      async run(job: {data: {n: number}}) {
        seen.push(job.data.n);
      }
    }
    ctx.bind('workers.Worker').toClass(Worker).tag(MESSAGING_PROCESSOR_TAG);

    const boot = new MessagingBootstrapper(ctx, queue, ctx.getSync(EVENT_BUS));
    await boot.start();
    await queue.enqueue(Q, {n: 42});
    await tick();
    expect(seen).toEqual([42]);
    await boot.stop();
  });

  it('stop() closes subscriptions so jobs stop being processed', async () => {
    const seen: number[] = [];
    class Worker {
      @jobProcessor(Q)
      async run(job: {data: {n: number}}) {
        seen.push(job.data.n);
      }
    }
    ctx.bind('workers.Worker').toClass(Worker).tag(MESSAGING_PROCESSOR_TAG);
    const boot = new MessagingBootstrapper(ctx, queue, ctx.getSync(EVENT_BUS));
    await boot.start();
    await boot.stop();
    await queue.enqueue(Q, {n: 1});
    await tick();
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: FAIL — `Cannot find module '../../bootstrapper.js'`.

- [ ] **Step 3: Implement `packages/agent-messaging/src/bootstrapper.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {loggers} from '@agentback/agent-common';
import {
  BindingScope,
  ContextTags,
  inject,
  lifeCycleObserver,
  type Context,
  type LifeCycleObserver,
} from '@agentback/core';
import {MetadataInspector} from '@agentback/metadata';
import type {JobProcessorMetadata, SubscriberMetadata} from './decorators.js';
import type {EventBus, JobQueue} from './ports.js';
import type {Subscription} from './types.js';
import {
  EVENT_BUS,
  JOB_PROCESSOR_METADATA_KEY,
  JOB_QUEUE,
  MESSAGING_PROCESSOR_TAG,
  MESSAGING_SUBSCRIBER_TAG,
  SUBSCRIBER_METADATA_KEY,
} from './keys.js';

const {info, debug} = loggers('messaging:bootstrapper');

export const MESSAGING_BOOTSTRAPPER_KEY = 'observers.MessagingBootstrapper';

/**
 * Discovers @jobProcessor/@subscriber-tagged bindings at start() and wires
 * each decorated method to the JobQueue/EventBus. Holds the returned
 * Subscriptions and closes them on stop().
 */
@lifeCycleObserver('10-messaging-bootstrapper', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: MESSAGING_BOOTSTRAPPER_KEY},
})
export class MessagingBootstrapper implements LifeCycleObserver {
  private subscriptions: Subscription[] = [];

  constructor(
    @inject.context() private ctx: Context,
    @inject(JOB_QUEUE) private jobQueue: JobQueue,
    @inject(EVENT_BUS) private eventBus: EventBus,
  ) {}

  async start(): Promise<void> {
    await this.wireProcessors();
    await this.wireSubscribers();
    info(
      'MessagingBootstrapper wired %d subscriptions',
      this.subscriptions.length,
    );
  }

  private async wireProcessors(): Promise<void> {
    const bindings = this.ctx.findByTag(MESSAGING_PROCESSOR_TAG);
    for (const b of bindings) {
      const instance = (await this.ctx.get(b.key)) as object;
      const all = MetadataInspector.getAllMethodMetadata<JobProcessorMetadata>(
        JOB_PROCESSOR_METADATA_KEY,
        Object.getPrototypeOf(instance),
      );
      if (!all) continue;
      for (const methodName of Object.keys(all)) {
        const meta = all[methodName];
        const sub = this.jobQueue.process(
          meta.descriptor,
          async job => {
            await (
              instance as Record<string, (...a: unknown[]) => Promise<void>>
            )[methodName](job);
          },
          meta.options,
        );
        this.subscriptions.push(sub);
        debug(
          'wired @jobProcessor %s.%s -> %s',
          b.key,
          methodName,
          meta.queueName,
        );
      }
    }
  }

  private async wireSubscribers(): Promise<void> {
    const bindings = this.ctx.findByTag(MESSAGING_SUBSCRIBER_TAG);
    for (const b of bindings) {
      const instance = (await this.ctx.get(b.key)) as object;
      const all = MetadataInspector.getAllMethodMetadata<SubscriberMetadata>(
        SUBSCRIBER_METADATA_KEY,
        Object.getPrototypeOf(instance),
      );
      if (!all) continue;
      for (const methodName of Object.keys(all)) {
        const meta = all[methodName];
        const sub = this.eventBus.subscribe(
          meta.descriptor,
          meta.group,
          async (event, msg) => {
            await (
              instance as Record<string, (...a: unknown[]) => Promise<void>>
            )[methodName](event, msg);
          },
          meta.options,
        );
        this.subscriptions.push(sub);
        debug(
          'wired @subscriber %s.%s -> %s',
          b.key,
          methodName,
          meta.topicName,
        );
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.subscriptions.map(s => s.close()));
    this.subscriptions = [];
    debug('MessagingBootstrapper stopped');
  }
}
```

> Note: the test constructs `MessagingBootstrapper` directly with `(ctx, queue, eventBus)`. The `@inject` decorators only apply when resolved through DI, so direct construction in the test is valid and bypasses them.

- [ ] **Step 4: Build and run the test**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/bootstrapper.unit.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): MessagingBootstrapper decorator discovery"
```

---

### Task 11: `MessagingComponent` (in-memory wiring) + barrel exports

**Files:**

- Create: `packages/agent-messaging/src/component.ts`
- Modify: `packages/agent-messaging/src/index.ts`
- Test: `packages/agent-messaging/src/__tests__/unit/component.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-messaging/src/__tests__/unit/component.unit.ts`:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {describe, it, expect} from 'vitest';
import {Context} from '@agentback/context';
import {InMemoryMessagingComponent} from '../../component.js';
import {EVENT_BUS, JOB_QUEUE, QUEUE_ADMIN, SCHEDULER} from '../../keys.js';

describe('InMemoryMessagingComponent', () => {
  it('binds all four messaging ports', () => {
    const ctx = new Context('app');
    const component = new InMemoryMessagingComponent();
    for (const b of component.bindings ?? []) ctx.add(b);

    expect(ctx.getSync(JOB_QUEUE)).toBeDefined();
    expect(ctx.getSync(EVENT_BUS)).toBeDefined();
    expect(ctx.getSync(QUEUE_ADMIN)).toBeDefined();
    expect(ctx.getSync(SCHEDULER)).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @agentback/agent-messaging build`
Expected: FAIL — `Cannot find module '../../component.js'`.

- [ ] **Step 3: Implement `packages/agent-messaging/src/component.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

import {createBindingFromClass} from '@agentback/context';
import {Binding, type Component} from '@agentback/core';
import {MessagingBootstrapper} from './bootstrapper.js';
import {InMemoryEventBus} from './in-memory/in-memory-event-bus.js';
import {InMemoryJobQueue} from './in-memory/in-memory-job-queue.js';
import {InMemoryQueueAdmin} from './in-memory/in-memory-queue-admin.js';
import {EVENT_BUS, JOB_QUEUE, QUEUE_ADMIN, SCHEDULER} from './keys.js';
import {DefaultScheduler} from './scheduler.js';

/**
 * Wires the in-memory messaging adapter to all four ports plus the
 * bootstrapper. Layer 2 ships a parallel RedisMessagingComponent binding the
 * BullMQ/Streams adapter to the same keys.
 */
export class InMemoryMessagingComponent implements Component {
  bindings: Binding[];

  constructor() {
    const queue = new InMemoryJobQueue();
    const eventBus = new InMemoryEventBus();
    const admin = new InMemoryQueueAdmin(queue.backingStore);
    const scheduler = new DefaultScheduler(queue);

    this.bindings = [
      Binding.bind(JOB_QUEUE).to(queue),
      Binding.bind(EVENT_BUS).to(eventBus),
      Binding.bind(QUEUE_ADMIN).to(admin),
      Binding.bind(SCHEDULER).to(scheduler),
      createBindingFromClass(MessagingBootstrapper),
    ];
  }
}
```

- [ ] **Step 4: Fill in the barrel `packages/agent-messaging/src/index.ts`**

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/agent-messaging
// This file is licensed under the MIT License.

export * from './descriptors.js';
export * from './types.js';
export * from './ports.js';
export * from './keys.js';
export * from './decorators.js';
export {
  MessagingBootstrapper,
  MESSAGING_BOOTSTRAPPER_KEY,
} from './bootstrapper.js';
export {DefaultScheduler} from './scheduler.js';
export {InMemoryMessagingComponent} from './component.js';
export {InMemoryJobQueue} from './in-memory/in-memory-job-queue.js';
export {InMemoryEventBus} from './in-memory/in-memory-event-bus.js';
export {InMemoryQueueAdmin} from './in-memory/in-memory-queue-admin.js';
export {InMemoryStore} from './in-memory/in-memory-store.js';
```

> Note: the conformance suite (`testing/conformance.ts`) is intentionally NOT exported from the main barrel — it imports `vitest`. It is reachable via the `@agentback/agent-messaging/testing` subpath declared in `package.json`.

- [ ] **Step 5: Build and run the test**

Run: `pnpm -F @agentback/agent-messaging build && pnpm exec vitest run packages/agent-messaging/dist/__tests__/unit/component.unit.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-messaging/src
git commit -m "feat(agent-messaging): in-memory component + barrel exports"
```

---

### Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Clean build the whole workspace**

Run: `pnpm build`
Expected: the new package builds in dependency order with the rest; no errors.

- [ ] **Step 2: Run the full agent-messaging test suite**

Run: `pnpm exec vitest run packages/agent-messaging/dist/__tests__/`
Expected: PASS — descriptors (3), JobQueue (6), EventBus (4), QueueAdmin (3), scheduler (1), decorators (2), bootstrapper (2), component (1).

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no new errors/warnings from `packages/agent-messaging` (fix any `any`/unused-var warnings the linter flags; prefix intentionally-unused vars with `_`).

- [ ] **Step 4: Confirm no existing callers changed**

Run: `git diff --name-only main -- packages | grep -v '^packages/agent-messaging/'`
Expected: empty output (only the root `tsconfig.json` + lockfile outside the new package, from Task 1) — proving coexistence: the old `RedisQueueService` shim and `AgentQueueManager` are untouched.

- [ ] **Step 5: Final commit**

```bash
git add -A packages/agent-messaging
git commit -m "test(agent-messaging): full build + suite green"
```

---

## Self-Review

**Spec coverage:**

- Package + zero-backend-deps + `/testing` subpath → Task 1. ✅
- Typed Zod descriptors → Task 2. ✅
- Four ports + value types (JobQueue/EventBus/QueueAdmin/Scheduler) → Tasks 3, 5–8. ✅
- DI keys + tags + metadata keys → Task 4. ✅
- In-memory adapter (JobQueue/EventBus/QueueAdmin) + per-group cursors + deliveryCount + poison routing → Tasks 5–7. ✅
- Shared conformance suite (the keystone) → Tasks 5–7, exported via `/testing`. ✅
- Implicit ack-on-resolve + redelivery → Task 6 (EventBus impl + conformance). ✅
- Imperative primitive + thin decorator → Tasks 5/6 (primitive) + 9 (decorators) + 10 (bootstrapper). ✅
- Scheduler as thin helper over JobQueue → Task 8. ✅
- MessagingComponent wiring + barrel → Task 11. ✅
- Coexistence (no caller changes) → Task 12 Step 4 verifies it. ✅
- Serialization/validation on enqueue AND consume → Task 5 (enqueue parse + process parse + poison test). ✅

**Spec items deliberately deferred (per spec non-goals), no task:** BullMQ/Redis adapter, engine integration, wall-clock cron firing, caller migration — all Layer 2.

**Placeholder scan:** No TBD/TODO; every code step has complete code; every run step has an expected result.

**Type consistency:** `JobContext`/`EnqueueOptions`/`WorkerOptions`/`MsgMeta`/`SubscribeOptions`/`QueueStats` defined in Task 3 are used unchanged in Tasks 5–11. Keys (`JOB_QUEUE`/`EVENT_BUS`/`QUEUE_ADMIN`/`SCHEDULER`, the two tags, the two metadata keys) defined in Task 4 are used unchanged in Tasks 9–11. `InMemoryStore`/`StoredJob` introduced in Task 7 replace the inline store from Task 5 (Task 7 Step 2 rewrites the file in full to avoid drift). `backingStore` accessor (Task 7) is used by Task 7 admin test and Task 11 component.

**One intentional refactor flagged:** Task 5 ships `InMemoryJobQueue` with an inline store; Task 7 extracts `InMemoryStore` and rewrites the file wholesale (full replacement shown, not a diff) so `QueueAdmin` can share state. This is called out so an out-of-order reader isn't surprised.
