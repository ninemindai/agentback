# Actor programming model

AgentBack models an actor as a **DI-resolved service implementing a typed state machine with a stable address**. Code invokes `{actor type, actor ID, command}` through `ActorRegistry`; the runtime allows only one command to change that actor's state at a time.

See the interactive [programming-model diagrams](architecture/diagrams/actor-programming-model.html) for discovery and turn lifecycle.

## The model

| Concept                    | Role                                                                            |
| -------------------------- | ------------------------------------------------------------------------------- |
| `Actor<S>`                 | Service contract requiring `initialState(id)`.                                  |
| `@actor` / `@actorCommand` | Zod contracts and extension metadata.                                           |
| `Component.services`       | Standard AgentBack registration path for actor classes.                         |
| `ActorRegistry`            | Discovers extensions and compiles service metadata.                             |
| `ActorRuntime`             | Routes each command to its identity's mailbox, serializes turns, commits state. |
| `ActorDefinition<S, C, R>` | Normalized lower-level adapter contract.                                        |

The service object is behavior, not durable state. Actor state remains an explicit method argument and return value, so instance lifetime does not affect persistence, rollback, or passivation.

## 1. Author an actor service

```ts
const CartState = z.object({items: z.record(z.string(), z.number())});
const AddItem = z.object({sku: z.string()});
const CartResult = z.object({itemCount: z.number()});

@actor('cart', {state: CartState})
class CartActor implements Actor<z.infer<typeof CartState>> {
  constructor(@inject('services.catalog') private catalog: Catalog) {}

  initialState() {
    return {items: {}};
  }

  @actorCommand('add', {input: AddItem, output: CartResult})
  async add(
    state: z.infer<typeof CartState>,
    input: z.infer<typeof AddItem>,
    ctx: ActorCommandContext,
  ) {
    await this.catalog.assertExists(input.sku);
    state.items[input.sku] = (state.items[input.sku] ?? 0) + 1;
    const itemCount = Object.values(state.items).reduce((a, b) => a + b, 0);
    return {state, result: {itemCount}};
  }
}
```

`@actor` contributes the service binding to `ACTOR_EXTENSIONS`. Each `@actorCommand` supplies one input/output contract. Commands are parsed before the method runs; next state and output are parsed before commit.

Actor services default to singleton scope because they hold behavior and injected dependencies, not per-actor state. A transient scope is also valid; serialization is keyed by actor identity, not service instance.

## 2. Contribute actors through a component

```ts
class CommerceComponent implements Component {
  services = [Catalog, CartActor];
}

const app = new Application();
app.component(InMemoryActorsComponent); // runtime + ActorRegistry service
app.component(CommerceComponent); // normal Component.services mounting
await app.start();
```

Component mounting registers each entry through `app.service()`. The `@actor` extension tag survives that path. On startup, `ActorRegistry` reads metadata without instantiating services, validates unique actor and command names, compiles normalized definitions, and registers them with `ActorRuntime`.

Actor instances are resolved through their original service binding only when `initialState` or a command method runs, so constructor injection and binding scope are honored.

## 3. Address and invoke

```ts
const actors = await app.get(ACTOR_REGISTRY);

const result = await actors.invoke(
  'cart',
  'customer-42',
  {name: 'add', input: {sku: 'keyboard'}},
  {requestId: 'checkout-7:add-keyboard'},
);
```

`cart/customer-42` is the state and serialization boundary. Another call using the same identity reaches the same logical state. `cart/customer-99` has independent state and may run concurrently.

`invoke` uses a command envelope because different decorated methods have different input/output types. For a typed call site, pass the **actor class** instead of its name: `actors.ref(CartActor, id)` returns a proxy whose methods mirror the `@actorCommand` methods, so `actors.ref(CartActor, id).add(input, {requestId})` is fully typed and routes through the same `invoke`. The proxy reads method _signatures_ (not the Zod schemas), so a command whose method declares no `input` parameter types its input as `unknown` — pass `{}`.

## The mailbox model

`invoke` is not a method call on the actor — it **posts a message** (the command envelope `{name, input}`) to the mailbox addressed by `{type, id}`. Each identity has its own mailbox, and the runtime drains it **one turn at a time** in submission order. `cart/customer-42` is a single serialized line of turns; `cart/customer-99` is an independent mailbox that may run concurrently. The in-memory adapter implements the mailbox as a per-identity promise chain; the Redis adapter as a per-identity lease — same contract, different backing. (The "One turn" steps below are what the runtime does once a message reaches the front of its mailbox.)

Sends are **request/reply — `ask`, not `tell`**. `invoke` resolves with the turn's result, or rejects if the handler throws or validation fails; there is no fire-and-forget primitive that posts a message and returns without awaiting the turn. That matches the callers — REST controllers and MCP tools need a reply to return — and it keeps the runtime honest: a command nobody awaits would need a durable inbox to survive a crash, and that is the job queue's role, not the in-process mailbox's.

For durable, asynchronous commands, enqueue a job (`@agentback/messaging`) whose processor calls `actors.invoke(...)`: the queue owns durability and retries, while the actor still owns per-identity serialization and state. (The Redis adapter persists completed turns but likewise does not durably queue _pending_ commands — see the Redis adapter section.)

## Discovery lifecycle

```text
CommerceComponent.services
          │ app.service(CartActor)
          ▼
@actor extension binding
          │ @extensions.view(ACTOR_EXTENSIONS)
          ▼
ActorRegistry.start()
          │ validate + compile metadata
          ▼
ActorDefinition → ActorRuntime.register()
```

Discovery is frozen at application startup. Actor bindings must be mounted before `app.start()`. Startup fails on duplicate actor names, duplicate command names, missing actor metadata, or actors with no commands.

## One turn

For each invocation the runtime:

1. validates the command envelope and computes its fingerprint;
2. joins the mailbox keyed by `{type, id}`;
3. loads or initializes state through the DI-resolved actor service;
4. replays a matching committed `requestId`, when present;
5. validates method input and resolves the actor service through DI;
6. invokes the decorated method with cloned state, input, and context;
7. validates next state and method output;
8. commits state plus request fingerprint/result, then replies.

If resolution, the handler, or validation fails, the state clone is discarded and the request ID remains retryable.

## Concurrency and idempotency

```text
cart/customer-42:  add A ─────► add B ─────► clear
cart/customer-99:       add X ─────► add Y
                       (may overlap customer-42)
```

Commands for one identity are serialized. Different identities may run concurrently. Retrying an identical command with a committed `requestId` returns the prior result; reusing that ID for another payload is rejected.

There is no cross-actor transaction or reentrancy. Placement, activation, fairness, timers, and supervision remain out of scope.

## State and side effects

Do not keep durable state in class fields. The runtime can discard its state clone after a failure, but it cannot undo an email, HTTP call, payment, or unrelated database write performed by a method.

Production actors should persist an outbox with state, call idempotent services using `requestId`, or store intent for a worker. In-memory rollback is not a distributed transaction.

## Redis adapter

`@agentback/actors-redis` rebinds `ACTOR_RUNTIME` to a singleton `RedisActorRuntime`. It reuses the exported `RedisConnectionManager` from `messaging-bullmq`, coordinates each identity with a renewable lease token, and atomically commits JSON state plus the dedup result in Lua. The lease token is the sole mutual-exclusion guard: the commit script re-checks lease ownership in the same Lua call (`GET(lease) == token`), so a stale holder cannot write — no separate fencing token is needed when the store does the check-and-set atomically. Reads (`state()`) take no lease. `installRedisActors` can own its manager or share `BullMQMessagingComponent.connections`.

This mode persists completed turns but does not durably queue pending commands. Durable request/reply queuing remains separate because the current `JobQueue` port has no result channel.

## Layer boundary

Decorated services are the application authoring model. `ActorDefinition` remains the normalized runtime port so an in-memory, Durable Objects, Redis, or another adapter does not depend on decorators or DI metadata.

REST controllers, MCP tools, chat handlers, and job processors are callers. Actors do not automatically become transport endpoints and do not add an agent loop.

A production adapter must preserve per-identity serialization, cross-identity concurrency, schema validation, rollback, request replay, collision rejection, and atomic persistence of state plus request result. A queue acknowledgement and unrelated state write do not meet that contract.
