# hello-actors

**Each `cart/<id>` is an addressable, serialized actor — exposed over REST.**
An actor here is just a DI service implementing a typed state machine with a
stable address. State is an explicit argument and return value (never an
instance field), so the runtime can serialize turns, validate every transition,
and roll back a failed one.

```
cart.actor.ts                 POST /carts/{id}/items (REST)
  @actor('cart')           ┌─► body: AddItem ─────────┐
  CartState (z.object) ────┤   Idempotency-Key header  │
  AddItem / CartView ──────┤   = requestId             │
  @actorCommand('add') ────┘                           ▼
                              ActorRegistry.invoke('cart', id, …)
                                 one turn at a time per id ──► commit state + result
```

The cart id in the URL is the actor's address. The `Idempotency-Key` header
becomes the turn's `requestId`, so a retried POST returns the committed result
without running `add` twice.

## What it demonstrates

- **Addressing** — `GET /carts/ada` and `GET /carts/grace` are independent
  state; different ids may run concurrently.
- **Serialized turns** — 20 concurrent `POST /carts/ada/items` all land
  (`itemCount: 20`), with no lost-update race.
- **Idempotency** — replaying an `Idempotency-Key` returns the committed result;
  reusing the key for a _different_ payload is rejected by the runtime.
- **Domain errors** — `CartActor` injects a `Catalog` service and throws an
  `AgentError` for an unknown SKU, which the REST server maps to a **400** the
  client can fix (a plain `Error` would be redacted to a generic 500).
- **One schema, many views** — `CartView` is the result of `add`/`clear` _and_
  the `GET` response.

## In-memory by default

This example uses `InMemoryActorsComponent`, so it runs with no external infra.
The component binds `ACTOR_RUNTIME` (the single-process reference adapter) and
the `ActorRegistry`, which at `app.start()` discovers every `@actor` service and
compiles its `@actorCommand` methods into the runtime's transport-neutral port.

## Run

```bash
pnpm -F hello-actors build
pnpm -F hello-actors start
```

Then:

```bash
# add two of the same SKU to cart "ada", idempotently
curl -s localhost:3000/carts/ada/items \
  -H 'content-type: application/json' \
  -H 'idempotency-key: add-keyboard-1' \
  -d '{"sku":"keyboard","qty":2}' | jq      # → {"items":{"keyboard":2},"itemCount":2}

curl -s localhost:3000/carts/ada | jq        # → same view
curl -s -X DELETE localhost:3000/carts/ada | jq   # → {"items":{},"itemCount":0}
# Swagger UI: http://localhost:3000/explorer/
```

## Test

```bash
pnpm -F hello-actors test
```

Tests run against `src` with vitest (esbuild transpiles on the fly), like a
standalone downstream app — see [`vitest.config.ts`](vitest.config.ts). They
drive the four properties above over HTTP with `createTestApp`'s supertest
bridge.

## Swapping in Redis (cross-process serialization)

Replace `InMemoryActorsComponent` with
[`@agentback/actors-redis`](../../packages/actors-redis)'s
`RedisActorsComponent` (via `installRedisActors`), which rebinds `ACTOR_RUNTIME`
to a Redis-backed runtime: per-identity leases coordinate one turn at a time
_across processes_, and state + dedup result commit atomically in a Lua script.
Nothing else changes — the `@actor`, the `@actorCommand` methods, and the
controller are identical:

```ts
import {installRedisActors} from '@agentback/actors-redis';

// in the application constructor, instead of `this.component(InMemoryActorsComponent)`:
installRedisActors(this, {connection: {url: process.env.REDIS_URL}});
```

> **Experimental.** The actor packages are a spike — the in-memory adapter is
> for tests and API validation, and the Redis adapter persists completed turns
> but does not durably queue pending commands. See the
> [programming-model guide](../../docs/actor-model.md) for the full semantics
> and non-goals.
