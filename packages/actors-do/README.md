# @agentback/actors-do

Durable Objects adapter for the `@agentback/actors` runtime port — **one
object per actor identity**, with state, the idempotency (dedup) record, and
the per-identity event journal persisted in the object's own storage and
committed in a single atomic multi-key `put`.

The adapter targets the **portable Durable Objects surface**: the
intersection of Cloudflare Durable Objects and [celld](https://celld.dev)
(the self-hosted DO runtime) — `idFromName` addressing, RPC stubs, and
SQLite-backed storage with atomic multi-key writes. Nothing
Cloudflare-only (Queues, KV, alarms) is required.

## What the platform gives, what the engine adds

A Durable Object is a single instance per name, globally — that is the
mutual-exclusion *placement* guarantee the Redis adapter builds with leases
and Lua scripts. It is **not** per-turn serialization: workerd interleaves
in-flight requests at await points, so the object runs its own seat (a
promise-chain mutex), and the rest of the actor contract — Zod validation,
rollback, `requestId` dedup and collision rejection, per-seat-class
deadlines, the timeout marker, the journal — is the same engine contract as
every other adapter, verified by the shared `runActorRuntimeConformance`
suite.

One structural difference an async store forces: the deadline races **load +
receive only**, and the commit runs outside the race, serialized through a
single storage section. An abandoned turn (deadline fired mid-phase) never
reaches its commit — the race discards the continuation — so the only
abandoned write left is `initialState` persistence, which re-checks
first-writer-wins inside the section. Same caller-visible semantics as Redis
("a stalled commit makes one caller wait"), same recorded-failed-turn
markers as the in-process journaling runtime.

## In-process (tests, dev, single process)

```ts
import {ACTOR_REGISTRY} from '@agentback/actors';
import {
  createInProcessDoActorRuntime,
  installDurableObjectActors,
} from '@agentback/actors-do';

const app = new Application();
installDurableObjectActors(app, {runtime: createInProcessDoActorRuntime()});
app.service(CartActor); // the same @actor class, unchanged
await app.start();

const actors = await app.get(ACTOR_REGISTRY);
await actors.ref(CartActor, 'ada').add({sku: 'kbd'}, {requestId: 'r1'});
```

`createInProcessDoActorRuntime()` wires the real engine to an in-memory host
that mimics the platform where it matters: calls cross the stub as structured
clones, and are delivered concurrently (never queued), so the engine's own
serialization is what's exercised.

## Cloudflare / celld deployment shape

Both sides of the RPC boundary must be able to construct the same
`ActorDefinition`s from the shared module graph — a Durable Object may run in
a different isolate (or machine) than the Worker that calls it, so the
definitions cannot be captured from the caller's live runtime.

```ts
// actor-definitions.ts — shared by the Worker and the DO class
export function actorDefinitions() {
  return [cartDefinition /* , ... */];
}

// worker.ts — the module Cloudflare/celld loads
import {createActorDurableObject, DurableObjectActorRuntime}
  from '@agentback/actors-do';
import {actorDefinitions} from './actor-definitions.js';

export const ActorDO = createActorDurableObject(actorDefinitions);

export default {
  async fetch(request: Request, env: Env) {
    const runtime = new DurableObjectActorRuntime(env.ACTORS);
    for (const definition of actorDefinitions()) runtime.register(definition);
    // hand `runtime` to installDurableObjectActors / your EdgeRestApplication
  },
};
```

```jsonc
// wrangler.jsonc — celld accepts jsonc (not toml) and rejects unknown keys
{
  "name": "my-service",
  "main": "dist/worker.js",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["js_rpc"],
  "durable_objects": {
    "bindings": [{"name": "ACTORS", "class_name": "ActorDO"}]
  },
  "migrations": [{"tag": "v1", "new_sqlite_classes": ["ActorDO"]}]
}
```

## Journal: read half only

The adapter persists a turn's `events` atomically with its commit and appends
the reserved `actor.turn.timeout` marker for a timed-out turn, so
`registry.events(type, id)` works exactly as on the journaling runtimes. It
implements `ActorEventReader`, **not** `ActorEventStore`: a Durable Object
has no portable push channel back to every caller, so
`registry.subscribe(...)` throws with the runtimes that do deliver named.
Read the log by identity, or bind `EventSourcedActorsComponent` /
`RedisActorsComponent` when you need live delivery.

## Exports

- `createActorDurableObject(loadDefinitions, {dedupLimit?})` — the DO class
  factory (export the result from your worker module).
- `DurableObjectActorRuntime` — caller-side `ActorRuntime` +
  `ActorEventReader` over a namespace binding.
- `installDurableObjectActors(app, {namespace | runtime})` — binds
  `ACTOR_RUNTIME` + `ActorRegistry`.
- `InProcessDurableObjectHost`, `createInProcessDoActorRuntime` — the
  single-process host.
- `ActorDoStorage` / `ActorDoState` / `ActorDoNamespace` / `ActorDoStub` —
  the structural platform surface (no Cloudflare type dependency).
- `TurnRequest` / `TurnOutcome` / `serializeActorError` / `reviveActorError`
  — the RPC envelope; errors cross the boundary as data and are revived
  typed (`TurnTimeoutError` keeps naming the turn whose deadline fired,
  domain-error `code`/`status`/`hint` properties survive).

## Layering

`@agentback/actors` defines the port and the authoring model; this package is
an adapter beside `InMemoryActorsComponent` (tests), the event-sourced
in-memory runtime, and `@agentback/actors-redis` (container fleets sharing a
Redis). Reach for it when the app deploys to Cloudflare Workers
(`EdgeRestApplication` + `agentback deploy cloudflare`) or a self-hosted
celld cluster.
