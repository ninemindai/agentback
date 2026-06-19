# Proposal E-2: `@agentback/extension-circuit-breaker` — outbound fault tolerance

**Status:** Draft (2026-06-18). Exploratory — not part of the reviewed
P0/P1 roadmap. Surfaced by a pattern-conformance audit of the framework
against the [Battle-Tested Patterns](https://totoro-jam.github.io/battle-tested-patterns/patterns/circuit-breaker/)
catalog, which found no circuit breaker anywhere in the workspace. This is the
**outbound dual** of the existing inbound [`extension-rate-limit`](../packages.md).

## Motivation

AgentBack is increasingly an _outbound_ framework. `mcp-host` proxies calls to
N upstream MCP servers; `mcp-client` calls remote Streamable-HTTP MCP servers;
the injectable `CoreBindings.FETCH` seam fronts every third-party HTTP call;
`payments` (x402) and the `metering` sink reach external services. Today a slow
or failing dependency is absorbed call-by-call: every request pays the full
timeout, sockets and event-loop turns pile up, and a single dead upstream can
stall the whole gateway. There is no mechanism to **stop calling a service that
is known to be down** and fail fast instead.

A circuit breaker is the standard answer: a three-state machine
(`closed → open → half-open`) that trips after a failure threshold, fails
immediately while open, and probes for recovery after a cooldown. It is
production-proven (Netflix Hystrix, Sony gobreaker) and maps almost one-to-one
onto AgentBack's outbound surfaces.

This is the framework's first _provided_ state machine — the conformance audit
graded the State Machine pattern as "enabled, not provided," because actor
state is dev-authored. The breaker ships one.

## Scope (derived from the catalog's When-NOT / Related guidance)

The pattern doc's "When NOT to Use" does not disqualify the breaker here — it
**scopes** it:

| Catalog signal               | Consequence for this design                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| When-NOT: in-process calls   | Wrap **outbound only** — never DI-internal calls.                                                                |
| When-NOT: fire-and-forget    | **Not** applied to the messaging EventBus; request-response egress only.                                         |
| When-NOT: idempotency unsure | Half-open probe + caller retries can double-fire non-idempotent POSTs → documented caveat + `isProbeSafe` guard. |
| Related: Retry/Backoff       | The breaker _gates_; it does not retry. Retry stays a separate, composable layer (`retry-backoff` / BullMQ).     |
| Related: State Machine       | The breaker is a 3-state machine with O(1) transitions — the first one the framework provides.                   |

### Goals

- A `CircuitBreaker` port (`closed → open → half-open`) with an **O(1)** per-call check.
- In-memory adapter (default) **and** an optional Redis-backed mode for
  fleet-wide tripping — one package, two stores, exactly like `extension-rate-limit`.
- Ergonomic integration with the `CoreBindings.FETCH` seam (`wrapFetch`) and a
  programmatic `breaker.execute(key, fn)` for `mcp-host`.
- A typed `CircuitOpenError` (via `AgentError`) that maps to **503 + `Retry-After`**
  on REST and a structured MCP error.
- Observable: a state-transition hook for `extension-otel` / `extension-metrics`.

### Non-goals

- **Retry** — separate concern; the breaker composes with it, never replaces it.
- **Fallback responses** — caller's job; we expose a `fallback?` hook but ship no default.
- **Bulkheads / inbound rate limiting** — out of scope (the latter already exists).

## Design

### The port

```ts
export type CircuitPhase = 'closed' | 'open' | 'half-open';

export interface CircuitBreaker {
  /** O(1) gate + execute. Throws CircuitOpenError when OPEN. */
  execute<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Current phase for a downstream key (observability / health). */
  state(key: string): Promise<CircuitPhase>;
  /** Manual override (ops escape hatch). */
  trip(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

export const CIRCUIT_BREAKER = BindingKey.create<CircuitBreaker>(
  'agentback.circuit-breaker',
);
```

### The hot-path split (core engineering decision)

The breaker's value depends on an **O(1) local check** on every call, so the
two responsibilities are split:

- **Per-call gate** — a cheap, in-memory read of the cached phase for `key`. No
  network, no lock. Local even in Redis mode.
- **State transitions** (trip, cooldown → half-open, probe result) — the
  coordinated path. In-memory mode: a local counter + timer. Redis mode: atomic
  Lua on a per-key hash, with the cached phase refreshed opportunistically.

This keeps the breaker honest about the O(1) invariant while still allowing
shared state. It is the answer to the perennial "you can't do a Redis
round-trip per call" objection: you don't — only transitions touch Redis.

### Half-open single-probe coordination

Only one probe may pass in the half-open state.

- **In-memory:** an atomic boolean — first caller into half-open carries the
  probe; others fast-fail.
- **Redis:** reuse the `actors-redis` lesson — `SET <probe-key> <token> NX PX <timeout>`.
  The `NX` winner is the sole probe, and the token guards against a stale probe
  committing a transition. This is the same one-holder primitive as the actor
  lease.

### Failure classification

Default `isFailure`: network errors, timeouts (`timeoutMs`), and HTTP **5xx**.
Explicitly **not** 4xx (a client error is not the dependency's fault) and not
`CircuitOpenError` itself (no self-counting). Overridable per breaker. Note for
`mcp-client`: its existing 401 → token-refresh-retry flow must classify as
non-failure so an expiring token does not trip the breaker.

### Integration surfaces

```ts
// (a) Wrap the injectable fetch seam — the ergonomic default. Any service
//     injecting CoreBindings.FETCH gets breaker-protected egress.
const protectedFetch = wrapFetch(globalThis.fetch, breaker, {
  keyBy: u => new URL(u).host,
});

// (b) Programmatic — mcp-host wraps each upstream proxy call.
await breaker.execute(`mcp:${upstreamName}`, () => upstream.callTool(req));
```

`mcp-host` is the first integration (highest value); the `FETCH` wrapper ships
alongside for everyone else.

### Error model

`CircuitOpenError extends AgentError` → `status: 503`, `code: 'circuit_open'`,
`retryable: true`, carrying `{key, retryAfterMs}`. `buildErrorEnvelope` already
turns this into a clean 503 (with `Retry-After`) on REST and a structured MCP
error — no new transport seam is required.

### Config (Zod, `@agentback/config`-friendly)

```ts
const CircuitBreakerConfig = z.object({
  failureThreshold: z.number().int().positive().default(5),
  rollingWindowMs: z.number().int().positive().optional(), // else consecutive
  cooldownMs: z.number().int().positive().default(30_000), // OPEN → HALF_OPEN
  halfOpenMaxProbes: z.number().int().positive().default(1),
  timeoutMs: z.number().int().positive().optional(),
  // store?: a RedisLike — its presence selects the Redis adapter (rate-limit pattern)
});
```

## Alternatives considered

| Option                                            | Verdict                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New `extension-circuit-breaker` package** (rec) | Matches the port+adapter idiom and `extension-rate-limit`'s "one package, memory+Redis" shape; reusable across `mcp-host`, `mcp-client`, `fetch`, `payments`.                    |
| Bake it into `mcp-host` only                      | Solves the killer case but strands `fetch`/`payments`; no reuse. Too narrow.                                                                                                     |
| Pure `wrapFetch` helper, no port                  | Cheap, but no DI binding, no Redis story, no `mcp-host` programmatic use.                                                                                                        |
| Circuit breaker as an `@actor`                    | Elegant (free serialized counting + lease-as-probe-gate), but a turn/Redis round-trip on every call violates the O(1) gate. Borrowed its _ideas_, not the actor on the hot path. |

## Testing

A shared **conformance suite** (à la `@agentback/files/testing`): the
three-state transition table, threshold tripping, cooldown → half-open,
single-probe under concurrency, failure-classifier correctness, and the Redis
adapter (ioredis-mock / testcontainers). Driven through `createTestApp` with a
stub `FETCH` that fails on command.

## Rollout & doc surfaces

Per the [CLAUDE.md](../../CLAUDE.md) documentation-surfaces checklist, the same
change updates:

1. New package + in-memory adapter + Redis mode + conformance suite.
2. `mcp-host` integration first; ship `wrapFetch` for the `FETCH` seam.
3. Package README, `docs/packages.md`, a `docs/guides/circuit-breaker.md`,
   `docs/README.md` learning path, the agent skill (`skills/agentback`),
   `CLAUDE.md` "New capability packages", and an `examples/hello-circuit-breaker`.

## Open questions

1. **Default store** — ship per-process as the default (simple; each instance
   learns independently) with Redis opt-in? _(Recommend yes — mirrors `extension-rate-limit`.)_
2. **Keying** — by host? full origin? caller-supplied? Default `keyBy: host`, overridable.
3. **`mcp-client` auth interaction** — confirm 401 → refresh-retry is classified
   as non-failure so token expiry never trips the breaker.
