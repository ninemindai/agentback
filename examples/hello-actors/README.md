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
  `AgentError` for an unknown SKU (or a checkout on an empty cart), which the
  REST server maps to a **400** the client can fix (a plain `Error` would be
  redacted to a generic 500).
- **State transitions** — `POST /carts/{id}/checkout` prices the cart via the
  `Catalog`, returns an `Order`, and empties the cart in one serialized turn;
  the `Idempotency-Key` makes the checkout safe to retry.
- **Read-only queries** — `GET /carts/{id}/total` is an `@actorQuery`: it runs
  **lease-free** (no turn, concurrent with commands) against a state snapshot.
- **One schema, many views** — `CartView` is the result of `add`/`clear` _and_
  the `view` query.
- **Inject the actor, not a client** — the controller injects a typed accessor
  with `@injectActor(CartActor)`; there is no hand-written client class.

## Injecting the actor

The controller never injects the raw `ACTOR_REGISTRY`, and it never injects the
`CartActor` instance — calling an actor's methods directly would bypass the
runtime (no serialization, rollback, or persisted state). It also doesn't need a
hand-written client class. Instead it injects a **typed accessor**:

```ts
@api({basePath: '/carts'})
export class CartController {
  constructor(
    @injectActor(CartActor) private carts: ActorAccessor<CartActor>,
  ) {}

  @post('/{id}/items', {
    /* …schemas… */
  })
  async add(input) {
    // this.carts(id) is the typed proxy for cart/<id>
    return this.carts(input.path.id).add(input.body, {
      requestId: input.headers['idempotency-key'],
    });
  }

  @get('/{id}', {
    /* … */
  })
  async show(input) {
    return this.carts(input.path.id).view({}); // an @actorQuery, lease-free
  }
}
```

`@injectActor(CartActor)` resolves to `(id) => registry.ref(CartActor, id)` — so
`this.carts(id)` is the typed proxy, with methods mirroring the `@actorCommand`
and `@actorQuery` methods. Every call still routes through the runtime, so all
its guarantees hold. Because `view` and `total` are queries on the actor, the
accessor covers reads too — no `Carts` facade required.

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

# check out: prices the cart (cents), returns an order, empties the cart
curl -s localhost:3000/carts/ada/checkout \
  -H 'content-type: application/json' \
  -H 'idempotency-key: order-1' \
  -d '{"note":"gift wrap"}' | jq            # → {"orderId":"order-1","lines":[…],"total":9998,…}

curl -s -X DELETE localhost:3000/carts/ada | jq   # → {"items":{},"itemCount":0}
# Swagger UI: http://localhost:3000/explorer/
```

## Test

```bash
pnpm -F hello-actors test
```

Tests run against `src` with vitest (esbuild transpiles on the fly), like a
standalone downstream app — see [`vitest.config.ts`](vitest.config.ts). They
drive the properties above over HTTP with `createTestApp`'s supertest bridge.

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

> The in-memory adapter is the single-process reference (tests and dev);
> `@agentback/actors-redis` adds cross-process serialization and persistence —
> completed turns are durable, though pending commands aren't queued. See the
> [programming-model guide](../../docs/actor-model.md) for the full semantics
> and non-goals.
