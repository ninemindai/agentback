# hello-jobs

**One Zod schema for the HTTP request body AND the job payload.** `EmailJob` is
defined once. `defineQueue('send-email', EmailJob)` binds it to a queue, and
that same schema:

- validates the `POST /emails` request body (and drives the OpenAPI doc),
- is the enqueue contract, validated on the way into the queue,
- is re-validated on the way out when the worker decodes the job.

The API and the worker can't drift, because there's only one schema.

```
jobs.ts                  POST /emails (REST)        EmailWorker (background)
  EmailJob (z.object) ─┬─► body: EmailJob ──┐        @jobProcessor(SendEmail)
  SendEmail ───────────┘   enqueue ─────────┴──► queue ──► job.data: EmailJob
   = defineQueue(...)                                       (re-validated)
```

## In-memory by default

This example uses `InMemoryMessagingComponent`, so it runs in CI with no Redis.
The component binds the four messaging ports plus the `MessagingBootstrapper`,
which discovers the `@jobProcessor`-tagged worker at `app.start()` and wires it
to the queue. Enqueue → process happens in-process.

## Run

```bash
pnpm -F hello-jobs build
pnpm -F hello-jobs start
```

Then:

```bash
JOB=$(curl -s localhost:3000/emails \
  -H 'content-type: application/json' \
  -d '{"to":"ada@example.com","subject":"Welcome"}' | jq -r .jobId)
curl -s localhost:3000/emails/$JOB | jq   # → {"jobId":"...","state":"completed"}
# Swagger UI: http://localhost:3000/explorer/
```

## Test

```bash
pnpm -F hello-jobs test
```

Tests run against `src` with vitest (esbuild transpiles on the fly), like a
standalone downstream app — see [`vitest.config.ts`](vitest.config.ts). The
test POSTs an email, uses `expect.poll` to wait for the worker to settle, then
asserts exactly one processed job with the posted payload and a `completed`
status. (Workspace package tests, by contrast, run against built `dist/`.)

## Swapping in BullMQ (durable, Redis-backed)

Replace `InMemoryMessagingComponent` with
[`@agentback/messaging-bullmq`](../../packages/messaging-bullmq)'s
`BullMQMessagingComponent`, which binds the same four ports to a BullMQ + Redis
Streams adapter. Nothing else changes — the controller, the worker, the
`@jobProcessor` tag, and the `EmailJob` schema are identical:

```ts
import {BullMQMessagingComponent} from '@agentback/messaging-bullmq';

// in the application constructor, instead of InMemoryMessagingComponent:
this.component(
  new BullMQMessagingComponent({connection: {url: process.env.REDIS_URL}}),
);
```

Durability, retries/backoff, and horizontal scale (multiple workers off one
Redis) come from the adapter; the in-memory adapter records but doesn't act on
repeatable/cron firing or priority — those are Layer-2 concerns.
