# Seat layer — release-notes draft (next lockstep release)

> **DRAFT — not a release.** The target version is not decided yet. Fold this
> into `docs/releases/vX.Y.Z.md` when it is, and delete this file. Everything
> below is already on `main`.

Written now because the seat-layer wave changed four shipped behaviors, and
the first — a default turn deadline on **every** existing actor — is the kind
of change that is discovered in production if it is not stated in the notes.

## ⚠️ Breaking changes

### `@agentback/actors`: every actor turn now has a deadline (headline)

Turns previously ran unbounded. They now run under a per-seat-class deadline,
and **an actor that declares nothing gets 30 seconds** — the `'capability'`
default, on the reasoning that a caller is usually waiting on the other end of
a REST request, MCP tool call, or agent turn.

**Who this breaks:** any existing `@actor` / `defineActor` whose command turns
legitimately run longer than 30s (a batch, an import, a long tool chain, a
slow third-party call). On upgrade those turns start throwing
`TurnTimeoutError` at 30s. Nothing is committed, the seat is freed, and the
failed turn is recorded — so it fails safely, but it fails.

**The fix is one line on the definition**, and there are two of them:

```diff
  // A turn nobody is blocked on: 10 minutes.
- @actor('nightly-import', {state: ImportState})
+ @actor('nightly-import', {state: ImportState, seatClass: 'worker'})

  // …or name the number outright; an explicit deadlineMs always wins.
- @actor('checkout', {state: CartState})
+ @actor('checkout', {state: CartState, deadlineMs: 90_000})
```

Bands: `'capability'` (default) = 30s, `'worker'` = 10min. Both are per turn,
and a turn's queue wait never counts against it.

Two related behaviors worth knowing before upgrading, both covered in
[docs/actor-model.md](../actor-model.md#turn-deadlines):

- A timed-out `requestId` stays **retryable** — a timeout is not a cached
  failure result — so an idempotent caller that already retries needs no change.
- The turn is **abandoned, not cancelled**. It keeps running and can never
  commit, but side effects it already performed still happened (as ever, the
  runtime rolls back actor state, not the world).

**Recommendation for the release:** the next version's `@agentback/cli` should
ship an **advisory** (not a codemod) for this in its `update` migration
registry — detection is a static source read for `@actor`/`defineActor` calls
that declare neither `seatClass` nor `deadlineMs`, and the advice is the diff
above. It is config/behavior-shaped, not source-mechanical: the CLI cannot know
which actors legitimately run long. The migration itself is deliberately not
written here, because it must be keyed to the target version number and that is
not decided.

### `@agentback/actors`: `ActorDefinition` gained required `seatClass` + `deadlineMs`

`defineActor` resolves both once, so every runtime reads one number instead of
re-deriving a default. They are therefore **required** on the
`ActorDefinition` interface (the `DefineActorOptions` you pass in keep them
optional).

This is a compile break only for code that builds an `ActorDefinition` **object
literal** by hand rather than calling `defineActor` — a custom runtime's test
fixture, say. `defineActor` callers, `@actor` classes, and every adapter in the
workspace are unaffected.

```diff
  const definition: ActorDefinition<S, C, R> = {
    name: 'thing', state, command, result, initialState, receive,
+   seatClass: 'capability',
+   deadlineMs: 30_000,
    __kind: 'actor',
  };
```

Prefer `defineActor(name, {...})`, which fills both in.

### `@agentback/actors`: `ActorEventStore.subscribe` accepts an async handler

The handler type widened from `(event) => void` to
`(event) => void | Promise<void>`. An `async` handler was always _accepted_ by
the old signature — `void` swallows any return type — but a rejection from one
escaped the runtime's per-subscriber `try`/`catch`, which only sees synchronous
throws, and surfaced as an unhandled rejection instead of the documented
"logged and skipped". Naming the promise in the type is what let the delivery
loop catch it.

**Who this breaks:** callers whose handler is a single expression that returns
a value — `subscribe(e => seen.push(e))` is the common one, since
`Array.prototype.push` returns a `number`. `void` accepted that by a special
TypeScript rule; the union does not, so it is now a compile error.

**The fix is braces** (or an explicit `void`), and it changes no behavior:

```diff
- runtime.subscribe(event => seen.push(event));
+ runtime.subscribe(event => {
+   seen.push(event);
+ });
```

Handlers that already return nothing, and every `async` handler, are
unaffected — those now simply have their rejections logged and skipped like a
synchronous throw.

### `@agentback/actors-redis`: `dedupTtlSeconds` is validated at construction

A fractional or out-of-range `dedupTtlSeconds` now throws from the
`RedisActorRuntime` constructor instead of being accepted and failing later.
`EXPIRE` runs mid-commit — after state and the dedup record are written — and
raises on such a value, which would split the one commit point. Rejecting it at
construction is what keeps that from happening; the commit script also floors
and range-checks the TTL as a second guard, skipping retention rather than
breaking the commit.

**Who this breaks:** a config passing e.g. `dedupTtlSeconds: 0.5`. It was
already broken at runtime — it now fails loudly at startup. Whole seconds
between `0` (no expiry) and `MAX_DEDUP_TTL_SECONDS` are accepted.

## ✨ Also in this wave

- **`@agentback/actors`** — `TurnTimeoutError`, `ActorSeatClass`,
  `SEAT_CLASS_DEADLINE_MS`, and the reserved `actor.turn.timeout` journal event
  are exported from the barrel. A timeout is a **recorded failed turn**:
  journaling runtimes append the marker to the identity's log, and every
  runtime logs it under `agentback:actors:deadline`.
- **`@agentback/actors-redis`** — lease renewal is capped at the turn's
  deadline, so a wedged turn's lease lapses and the seat becomes claimable
  across processes instead of being held for as long as the turn runs.
- **`@agentback/actors-redis`** — the turn deadline now covers the **state
  load**, not just `receive`, matching the in-process runtimes. A cold
  identity whose `initialState` hangs used to yield no `TurnTimeoutError`, no
  marker, and an `invoke()` promise that never settled; it is now an ordinary
  recorded failed turn (marker journaled, seat freed, `requestId` retryable).
- **`@agentback/actors-redis`** — **opt-in journal retention**
  (`journal: {maxEventsPerIdentity}`). Unset — the default, and every prior
  release's behavior — keeps every event. When set, the cap is applied by the
  same `XADD` that appends, so the one commit point stays one script. `seq`
  still comes from the identity's counter, so a trimmed log reads as a suffix
  with its numbering intact; what it costs is replay-from-zero, since a
  consumer whose cursor predates the oldest retained entry has a real gap.
  Archive (`seat.journal.archiver`) or leave retention unset if you need the
  full history.
- **`@agentback/actors-redis`** — `SeatJournalConsumerHost` **persists a cursor
  per consumer id**, so a restart no longer replays every identity's whole
  history to every DI-registered consumer. Delivery stays at-least-once (the
  cursor is written after the handler returns), and a consumer id the store has
  never seen still starts from `seq` 0. A cursor that retention has outrun is
  logged as a gap and resumed from the oldest retained entry, never thrown.
- **`@agentback/actors`** — an actor **type or id containing a C0 control
  character** (`U+0000`-`U+001F`) is now rejected at validation, on every
  runtime. Such ids were silently accepted before and were aliasing-prone: the
  in-process runtimes and the Redis journal subscriber key a seat on
  `type + U+0000 + id`, so a NUL inside a caller-supplied id (a REST path
  param, an MCP tool arg) made two different identities share one seat's state,
  dedup, journal and cursor. An id that "worked" that way now throws naming the
  offending half; ordinary ids, punctuation included, are unaffected.

## Known gaps to mention in the notes

- On Redis the deadline stops at the commit boundary. Once the commit script
  has been issued, a commit that stalls in Redis makes that one caller wait —
  the _seat_ is still bounded by the renewal cap, so the identity cannot wedge.
  In process there is no such gap (the commit is synchronous).
  _(The `initialState` gap listed here before is closed: the Redis race now
  covers the state load, so a hanging cold start is a `TurnTimeoutError` plus a
  journaled marker like any other failed turn.)_
