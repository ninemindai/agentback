# Proposal: revertible installs — every `install*` returns its inverse

**Status:** Draft (2026-08-13); **wave 1 implemented** the same day —
`composeTeardown` (`@agentback/common`), `Installed` (`@agentback/core`),
`addFetchHandler`/`addFetchPrefix` removers (`@agentback/rest`), and
`installExplorer` returning `Installed` with the gate-flag Express pattern
(`@agentback/rest-explorer`, conformance test in
`uninstall.integration.ts`). **Wave 2 implemented** as well: the shared
conformance suite (`runInstallConformance` in `@agentback/testing`), the
unbound-controller gate (an unbound controller's routes answer 404 on both
hosts instead of a resolver 500 — `findControllerBindingKey`, exported from
`@agentback/rest`), and `installContextExplorer` / `installSchemaExplorer` /
`installInspector` (+`installInspectorApi`, whose return widened to
`InstalledInspectorApi = Installed & {connect}`) all return `Installed`.
When `connect` is set, `installMcpConnect`'s nested footprint is not yet
retracted — that rides the mcp-connect wave. **Wave 3 implemented**:
`installMcpHttp` returns `Installed` — `McpHttpHandle` gained `uninstall()`
on all three mounts (gate flag on the six Express registrations; fetch-host
removers), and the install composes handle teardown + the `onStop` binding
unbind (`onStop` already returns its `Binding`, so no new lifecycle API was
needed) + the `ax.sections.mcp` unbind. The conformance suite gained
`{path, init}` probes and a `hosts` option (installMcpHttp mounts one host
per app, so it runs once per host). Fixing this wave also surfaced a real
seam bug: the native listener captured `fetchHandler()` once at start, so
handler removals never reached it — it now re-reads the memoized host per
request. **Wave 4 implemented**: `ConsoleFeature.install` widened to
`void | Installed` (duck-typed — third-party features returning `void` keep
working) and the four built-in feature factories return their `Installed`;
`installConsole` composes gated auth layers + feature teardowns + shell
teardown and its return now carries `uninstall` alongside
`{basePath, features}`; `installAgent` returns `Installed` (destroys live
sessions, unbinds the three agent bindings, deregisters its stop hook);
`installChat`'s `ChatHttpHandle` gained `uninstall()` (webhook routes
gated, chat shut down once, stop hook deregistered). One carve-out:
`ChatServer.register` has no inverse — the registered runtime stays on the
server after uninstall, inert (routes retracted, chat shut down). **Wave 5
implemented**: `installHealth`, `installMetrics`, `installRateLimit`,
`installOtel`, `installMcpConnect` (returns `RemoteRegistry & Installed`;
closes upstream connections only when the install created the registry), and
`installPriceGate` all return `Installed` — and `installInspectorApi` now
retracts its nested mcp-connect mount, closing the wave-2/4 carve-out.
Remaining documented carve-outs: prom-client's `collectDefaultMetrics`
registers process-global collectors with no removal handle, and
`ChatServer.register` has no inverse. The **konsistent rule was evaluated
and deferred**: `exportFunctions.returnValueOfType` exists but requires
exact literal names (no `install*` pattern), so one generic rule is not
expressible and per-helper enumeration would be brittle noise — revisit if
konsistent grows name patterns. The conformance suite remains the net.
Surfaced by the Cordis study
([cordis-spatiotemporal-composability.md](cordis-spatiotemporal-composability.md)):
of everything Cordis does, the one discipline that transfers to AgentBack at
~5% of the machinery is _mount functions return their inverse_. This proposal
pins down the contract, the composition rule, the Express-unmount question,
and the migration order. It deliberately does **not** import fibers, epochs,
reactive reload, or effect reversal of arbitrary side effects.

## Motivation

The workspace has ~18 `install*` helpers (`installMcpHttp`, `installConsole`,
`installExplorer`, `installAgent`, `installChat`, `installHealth`,
`installMetrics`, `installRateLimit`, the explorer trio, …). Each one performs
a footprint of registrations — Express layers, fetch handlers, DI bindings,
lifecycle hooks, background resources — that exists today only as the sequence
of side effects in its body. Three costs follow:

1. **The footprint is unauditable.** Nothing states what `installConsole`
   touched; answering "what did this helper do to my app?" means reading its
   body and every feature it composed. A returned inverse makes the footprint
   a value.
2. **Tests can't retract a capability.** `createTestApp` boots one fixed app
   shape per test; exercising "app with X" vs "app without X" means two apps.
   Install/uninstall mid-test is cheaper and closer to how operators think.
3. **`@agentback/plugin` has no unmount story.** A plugin system that can gate
   and mount but never dismount is half a lifecycle. If the helpers a plugin
   composes already return inverses, plugin unmount becomes composition; if
   they don't, it becomes archaeology per helper, forever.

The Cordis paper proves what the disciplined version of this buys (recovery
exactness, confluence). We are not claiming those theorems — we are adopting
the invariant that makes them thinkable: **no mount without its inverse.**

## The contract

```ts
// @agentback/core (new)
export interface Installed {
  /**
   * Revert every registration this install performed, in reverse order.
   * Idempotent: the second call is a no-op. Never throws for "already
   * uninstalled"; aggregates real disposer failures into one error.
   */
  uninstall(): Promise<void>;
}
```

Every `install*` helper's return type changes from `Promise<void>` to
`Promise<Installed>` (helpers that already return a handle, like
`mountMcpHttp`'s `McpHttpHandle`, extend it with `uninstall`). Callers who
ignore the return value are unaffected — this is **non-breaking for every
existing call site**. One nuance: code that stores an installer in an
explicitly-typed registry (`install: () => Promise<void>`) still typechecks
(return-type covariance), but a registry that _round-trips_ the resolved
value through its own `void`-typed field loses the `Installed` — such
registries should widen to `void | Installed`, as `ConsoleFeature.install`
did.

Rules of the contract:

- **Complete:** `uninstall` reverts everything the install registered —
  Express layers, fetch handlers/prefixes, bindings, lifecycle hooks, timers,
  session stores. "Mostly unmounted" is not a state.
- **Reverse order:** disposers run LIFO, matching Cordis and matching how
  dependencies stack (what was mounted on top comes off first).
- **Failure-tolerant:** one failing disposer must not strand the rest. Run
  all, aggregate failures (`AggregateError`), report once.
- **Idempotent:** double-uninstall is a no-op; uninstall after `app.stop()`
  is a no-op for anything stop already tore down.
- **Scope-fenced:** the inverse reverts the install's _registrations_, not
  the world. Requests already served, events already emitted, rows already
  written stay — this is the paper's system-boundary line (§6.1), drawn
  deliberately at the same place.

## The composition rule: `composeTeardown`

One small utility in `@agentback/common` is the implementation vehicle —
roughly Cordis's `effect()` stripped of fibers:

```ts
export interface Teardown {
  /** Register one disposer; returns it for chaining. */
  push(dispose: () => void | Promise<void>): void;
  /** Run all registered disposers in reverse; idempotent; aggregates errors. */
  run(): Promise<void>;
}
export function composeTeardown(): Teardown;
```

Helper bodies then read as mount-and-record:

```ts
export async function installExplorer(app, options): Promise<Installed> {
  const td = composeTeardown();
  td.push(mountIndexRoute(server, opts)); // each mount returns its inverse
  td.push(mountStaticAssets(server, opts));
  td.push(server.addFetchPrefix(opts.path, serve)); // now returns a disposer
  return {uninstall: () => td.run()};
}
```

A failure mid-install calls `td.run()` before rethrowing, so a half-installed
helper cleans up after itself — the same guarantee Cordis's `effect` gives.
The one order-sensitive thing in the whole design, drawn once:

```
install order  ─────────────────────────────►   (each step pushes its inverse)

  bind controller      mount UI shell      register fetch handlers      bind ax / onStop
        │                    │                       │                        │
        ▼                    ▼                       ▼                        ▼
  td: [unbind]  →  [unbind, gate-off]  →  [unbind, gate-off, removers]  →  [... , unbinds]

uninstall = td.run()  ◄─────────────────────────  LIFO: last mounted, first retracted

  unbind ax/onStop  →  remove fetch handlers  →  gate off UI  →  unbind controller

mid-install failure at step N:  td.run() replays inverses 1..N-1, then rethrows
                                (nothing half-installed survives)
```

### Addendum: `installSteps` makes the mid-install rule structural

The paragraph above — "a failure mid-install calls `td.run()` before rethrowing"
— is a rule the helper author has to remember, at *every* early exit. In
practice they didn't, uniformly. `installConsole` carried two byte-identical
`catch (err) { await td.run().catch(() => {}); throw err; }` blocks, and the
region before the first `try` (the auth gate and its `expressApp.use` loop) was
covered by neither: a throw there leaked the gate.

`installSteps` (`@agentback/common`) moves the rule into the calling
convention. The helper is an async generator that performs a step and then
`yield`s the inverse for *that* step; the runner collects each disposer
**before** resuming the body, so an inverse exists for every step that has
landed, at every suspension point:

```ts
export async function installSteps<R>(
  steps: () => AsyncGenerator<Disposer, R, void>,
): Promise<{value: R; teardown: Teardown}>;

/** …merged with the value as `uninstall`, for the common case. */
export async function installStepsAs<R extends object>(
  steps: () => AsyncGenerator<Disposer, R, void>,
): Promise<R & {uninstall(): Promise<void>}>;
```

This is the shape Cordis uses for the same reason (`ctx.effect` takes a
generator, not a function returning a disposer): a function can only hand over
its cleanup *after* succeeding, so a setup that fails at step 3 of 4 has
nothing to offer for steps 1 and 2. A generator hands over each inverse as it
earns it.

Yield placement is the reviewable artifact, and ordering is deliberate — hand
over a step's inverse *before* anything that can throw on what it produced.
DSH's `SessionStore` is the canonical example: `yield this.enter(session)` runs
before `this.announce(session)`, so a throwing `session/created` listener rolls
the store entry back instead of leaking an entry with live hooks.

Two deliberate choices:

- **The install's error stays the thrown value.** A rollback that also fails
  must not replace the caller's diagnosis with an `AggregateError` at the worst
  possible moment. The failing disposer is logged under
  `agentback:common:install-steps` instead — which *is* a behaviour change from
  the `.catch(() => {})` it replaces, where a failed rollback was silent.
- **Async only, for now.** Sync helpers (`mountConsole`) keep `composeTeardown`
  directly. Branching on `Symbol.iterator` vs `Symbol.asyncIterator` — what
  Cordis does — is deferred until a sync helper actually has multi-step
  rollback worth covering.

`installSteps` is additive: `composeTeardown` is unchanged and every existing
caller keeps working. `@agentback/plugin`'s `tryMount` deliberately does *not*
adopt it — it reverts a binding snapshot diff, because `app.component()` runs
its side effects before a collision is detectable and there are no per-step
inverses to yield. Different failure shape, different mechanism.

### Addendum: the additive half

The contract above is about retraction, and it made retraction work on a
*running* app. Addition had no counterpart: a plugin mounted after `app.start()`
had its observers bound and **never notified**, and its routes and tools
collected into surfaces that were built once and never re-derived. It mounted
inert — bound, discoverable, silently doing nothing.

Three pieces close it, and one rule ties them together: **a mount handle means
bound AND lifecycle-started AND served, or the mount fails and unwinds all
three.**

**1. `startObservers(keys)` / `initObservers(keys)`** — the additive
counterparts of `stopObservers`. Two design notes:

- **Two passes, not one.** `notifyGroups(['init', 'start'])` iterates events
  *inside* each group, yielding `g1.init, g1.start, g2.init, g2.start` — whereas
  `Application` runs `init()` across every group and only then `start()`.
- **Phase decides what is owed.** From `initialized`, `Application.start()` is
  `if (!this._initialized) await this.init()`, so `init` never runs again while
  the pending `registry.start()` still notifies everything. Owing `init` only
  there is what stops the mount *time* from changing the lifecycle a plugin
  receives.
- **`startObservers` is transactional.** `notifyObservers` is a serial `await`
  loop (and `Promise.all` in parallel mode), so a throw leaves the EARLIER
  observers started. Unbinding them then makes them unreachable — the full
  `stop()` pass resolves through the view, which no longer contains the key — so
  their sockets and timers survive with nothing able to stop them. It therefore
  tracks per-observer via an `onNotified` hook and stops what it started.
  `settle` makes the parallel path await every settlement first, so a sibling
  cannot still be starting while we unwind.
- **The view must be refreshed first.** `ContextView` caches bindings and is
  invalidated **asynchronously**; a partial notify runs precisely because
  bindings just changed, so the cache is reliably stale. The first draft found
  zero groups and started nothing.

**2. `RefreshableSurface` + `refreshSurfaces(app)`** — servers re-derive on
demand. `RestServer` re-runs `mountAllControllers()` (idempotent: `controller()`
skips a class it already mounted, and marks it only after every route landed)
and drops the fetch memo, **after** validating the candidate table on the native
host. Failures are **returned, not logged** — `loggers()` is debug-namespaced,
so a logged failure is the `.catch(() => {})` it replaced.

**3. MCP derives everything per request.** Tools already used low-level
handlers; resources and prompts moved off the SDK's high-level
`registerResource`/`registerPrompt`, which reject duplicate names and therefore
froze them for the life of a server. Addition and retraction stop being two
mechanisms — both fall out of asking the container at request time.

Two traps worth recording:

- **A refresher would have pointed at the wrong object.** The first attempt
  kept a baked tool map and exposed `refreshSurface()` on `MCPServer` targeting
  `this.mcp` — which under the shipped default `protocol: 'both'` is never
  connected to a transport at all (`serveStdio` builds one server per
  connection). Its test passed only because it pinned `protocol: 'legacy'`.
- **Lazy derivation must not defer schema validation.** `compileTool` emits JSON
  Schema eagerly so a schema that validates but cannot describe itself fails at
  `buildServer()`, not at some client's first `tools/list`. Moving derivation
  into the handlers moved that failure with it; `registerAllOn` now compiles
  once eagerly and discards the result.

**Not a carve-out, a scope line:** `mountResolved` is serialized per Application
by a lock. That is preventive, not a bug fix — the section's current safety
rests on where the awaits happen to sit, which no comment enforced. No
corrupting interleave could be constructed.

## The two hard mechanics

### Express can't unmount

Express (v5 included) has no public API to remove a mounted layer. Three
options, in ascending invasiveness:

1. **Gate flag** — each handler the helper registers closes over a `live`
   boolean; uninstall flips it and the handler calls `next()` (falls through
   to 404/other routes). Zero framework changes, works today, leaves dead
   layers in the stack (negligible: a boolean check per request).
2. **Per-install router** — mount all of a helper's routes on one
   `express.Router()` added via `app.use(router)`; uninstall empties
   `router.stack`. Cleaner grouping, still leaves the (now empty) `use` layer.
3. **Stack surgery** — splice `expressApp._router.stack`. Rejected: private
   API, order-fragile, exactly the kind of cleverness that breaks on an
   Express patch release.

**Recommendation: (1) now, (2) where a helper mounts ≥3 layers.** The gate is
honest about Express's limits and trivially correct.

### The fetch host needs disposers at the seam

`RestServer.addFetchHandler` / `addFetchPrefix` currently return `void`. They
should return `() => void` (remove the handler) — a small additive change in
`@agentback/rest`, and the natural shape for the neutral host anyway (it's a
plain handler list, removal is a splice). Same for anything the helpers
register through `app.onStop(...)`: the lifecycle registration should hand
back its removal, so uninstall can deregister the hook it added
(`installMcpHttp`'s `onStop(() => handle.closeAll())` must not fire for a
handle that uninstall already closed).

DI bindings are already fine: `app.bind(key)` has `app.unbind(key)` as its
exact inverse, and `Binding` instances carry their key.

## Migration order

Smallest footprint first, richest last, so the contract hardens on easy cases
before it meets sessions:

| Wave | Helpers                                                                                                       | Why this wave                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `installExplorer`                                                                                             | Pure mounting: 3 Express layers + 3 fetch handlers, zero bindings. Proves the contract + `composeTeardown` + both host paths.                                                                                                                                       |
| 2    | `installInspector`, `installContextExplorer`, `installSchemaExplorer`                                         | Same shape as wave 1 plus an `@api` controller binding each (`unbind` suffices).                                                                                                                                                                                    |
| 3    | `installMcpHttp`                                                                                              | The rich case: routes on both hosts, the `ax.sections.mcp` binding, an `onStop` hook, **live session transports** (`handle.closeAll()` becomes part of `uninstall`). Sets the precedent for stateful teardown.                                                      |
| 4    | `installConsole` + `ConsoleFeature.install`                                                                   | Composition test: a console feature's `install` returns `Installed`, and the console's own uninstall is the composition of its features'. `installAgent`, `installChat` ride the same wave (session destruction already exists on stop; move it behind the handle). |
| 5    | `installHealth`, `installMetrics`, `installRateLimit`, `installOtel`, `installMcpConnect`, `installPriceGate` | Mechanical once the pattern is proven.                                                                                                                                                                                                                              |

Out of scope: `installRedisActors` / `installDurableObjectActors` (component
registration with external state — their teardown is `app.stop()`'s job and
already handled by lifecycle), `installFastifyHost` (host selection, not a
capability mount), CLI-internal `install*` functions (unrelated namesakes).

## Verification

- **Conformance test per helper**, same spirit as `@agentback/files/testing`:
  boot `createTestApp`, install, assert the surface exists (route answers,
  binding resolves), uninstall, assert the footprint is gone (route 404s on
  both hosts, `app.isBound(...)` false, no `onStop` hook fires for it, double
  `uninstall()` resolves). One shared suite parameterized by helper keeps the
  contract from decaying helper-by-helper.
- **konsistent rule** (optional, later): `install*` exports in `packages/*/src`
  must declare `Promise<Installed>` — turning the convention into a check.

## What this is not

- **Not hot swap.** Nothing here reloads dependents when a capability leaves;
  `ContextView`s keep providing discovery-level reactivity, unchanged.
- **Not effect reversal.** External side effects are out of scope by the same
  system-boundary argument the Cordis paper makes for itself.
- **Not a plugin system redesign.** It is the substrate `@agentback/plugin`
  unmount would compose; that feature remains its own proposal.

## Open questions

1. Should `Installed` also expose the footprint for inspection
   (`{routes: string[], bindings: string[]}`) — useful for context-explorer —
   or is that scope creep on v1? (Lean: v1 is `uninstall` only.)
2. Does `app.stop()` implicitly uninstall everything installed, or are the
   two lifecycles independent? (Lean: independent — stop tears down servers;
   uninstall retracts capability registrations; disposers must be idempotent
   so either order is safe.)
3. Wave 4's `ConsoleFeature` is a public-ish interface; changing `install`'s
   return type is additive (`void → Installed`) but third-party features
   returning `void` should keep working — accept `void | Installed` there?

## Follow-ups (from the PR #51 eng review + cross-model pass)

- **Extract the gate helpers.** ~~Hand-rolled in ~8 packages~~ **Done**
  (post-merge follow-up): `installGate()` in `@agentback/rest` — one
  liveness flag per install, `gate` for METHOD chains (dead →
  `next('route')`), `wrap(mw)` for `use`-layers (dead → pass-through),
  idempotent `off()`. All eleven call sites migrated; the conformance
  suites are the regression net.
- **Per-mount handles for `installMcpConnect` registry reuse.** Reusing one
  caller-provided registry across mounts currently chains uninstalls
  (nothing becomes unretractable, but retraction is coarse). The granular
  per-mount handle rides the `@agentback/plugin` unmount wave — now drafted
  as [plugin-composability.md](plugin-composability.md).
- **Conformance suite depth.** Added this review: reinstall, stop-then-
  uninstall, failure-cleanup, auth-gating, upload-side-effect tests. Still
  worth adding when plugin unmount lands: same-path shadowing/restore
  ordering, multi-install shared-state, and a resource-release audit
  (handles/timers) per helper.
