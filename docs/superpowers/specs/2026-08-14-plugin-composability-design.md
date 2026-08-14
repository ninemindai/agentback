# Plugin Composability — Design

**Date:** 2026-08-14
**Package:** `@agentback/plugin`
**Proposal:** [docs/proposals/plugin-composability.md](../../proposals/plugin-composability.md)

## Summary

Two additive changes to `@agentback/plugin`:

- **Part A (temporal) — unmount.** `loadPlugins` returns a report that
  satisfies `Installed`, so a mounted plugin set can be retracted. The
  footprint comes from the binding snapshot `tryMount` already computes and
  currently discards.
- **Part B (spatial) — a declared dependency graph.** The `agentback`
  package.json marker gains `provides` and `inject` (binding keys). Mount
  order is derived by topological sort instead of hand-maintained in
  `order:`, and a duplicate `provides` is a collision detected **before any
  plugin is imported**.

Neither part introduces reactivity, fibers, HMR, or per-plugin contexts. The
DI container stays the authority at resolution time; declarations are
advisory and govern ordering and early detection only.

## Motivation

`revertible-installs.md` named "`@agentback/plugin` has no unmount story" as
its third motivation, then deliberately scoped itself to the substrate. Two
of its follow-ups are explicitly blocked on this work: granular per-mount
handles for `installMcpConnect` registry reuse, and the deferred conformance
depth (same-path shadowing/restore ordering, multi-install shared state). The
substrate shipped; this unblocks them.

Separately, `order:` is today the only ordering lever and is maintained by
hand — the "manual boot sequencing" a declared graph exists to remove.

## Design decisions (resolved during brainstorming)

| # | Question | Decision | Why |
|---|----------|----------|-----|
| 1 | Scope | Part A + Part B together | They compose: static `provides` makes a footprint predictable rather than purely observed, and one round of doc-surface updates instead of two. |
| 2 | Where the inverse lives | `PluginLoadReport extends Installed` | Additive — no existing caller changes — and it matches the `install*` precedent of hanging the inverse on the returned thing. Accepted cost: the report is no longer a pure serialisable record. |
| 3 | `uninstall()` vs. running lifecycle observers | Unbind **and** await `stop()` | Unbinding deregisters an observer from future lifecycle runs but leaves an already-started one holding its resources. Accepted cost: `uninstall()` can now fail for non-binding reasons, which `composeTeardown`'s `AggregateError` already handles. |
| 4 | What `inject` names | Binding keys only | Matches `provides` and the container's own vocabulary; avoids nominal plugin-to-plugin coupling, and lets a plugin depend on a key the **app itself** binds. |
| 5 | Footprint mechanism | Snapshot diff; the provenance tag is **not** a retraction source | See below — the tag provably misses bindings and cannot express the override case. |
| 6 | Does `app.stop()` uninstall plugins? | No — independent lifecycles, but **order-guarded** | Inherited from `revertible-installs.md`. The inherited rationale said "disposers are idempotent so either order is safe"; the eng review showed that premise is false for observers we do not own (see decision 8), so uninstall gates on app state instead of assuming idempotence. |
| 7 | Part B kept, against the outside voice | Ship A+B | Codex argued `provides`/`inject` is a second source of truth that can go stale. Rejected: the declaration never replaces the snapshot diff (which stays the net for undeclared bindings), and it moves duplicate-key detection **ahead of** `app.component()`'s side effects — something the diff structurally cannot do. The staleness point is real and is recorded under Known limits. |
| 8 | How `uninstall()` stops observers | Through the lifecycle registry, only when the app is `started`/`initialized` | Calling `observer.stop()` directly bypasses `invokeMethod` method injection, group ordering, disabled groups, and the `parallel` setting (`lifecycle-registry.ts:153-165`), and would run `stop()` on a never-started app where `Application.stop()` explicitly no-ops (`application.ts:406`). |
| 9 | MCP-contributed tools | Retract them properly, in this change | An unbound `@mcpServer` stays in a built server's `tools/list`, and `resolveMember` falls back to `new ctor()` (`mcp.server.ts:938-940`) — so an unmounted tool stays **callable, without DI**. A silently-live unmounted tool is exactly the failure this package's posture forbids. |

### Why the provenance tag is not the mechanism (decision 5)

`mountComponent` tags every binding a component contributes with
`CoreTags.FROM_COMPONENT`, which makes `app.findByTag({fromComponent: name})`
look like a free footprint. It is not sufficient, for two independent
reasons:

1. **`app.component()` instantiates the component before any tag is applied**
   (`application.ts:487`). A component whose constructor injects the
   Application and binds directly — a normal LB4 pattern — contributes
   **untagged** bindings the query never sees.
2. **Provenance is last-wins** (`component.ts:112`). For a key re-bound under
   `allowOverride` the tag names only the survivor, but retraction needs the
   *displaced* binding in order to restore it.

The snapshot diff has neither problem: it captures everything bound during
the mount window regardless of how, and `before.get(key)` **is** the
displaced binding. The tag keeps its current job as a provenance/audit
surface (context-explorer reads it) and must not be "simplified" into a
retraction source later.

## Architecture

```
loadPlugins(app)
  │
  ├─ discover()      package.json markers, off disk  ── now also: provides[], inject[]
  ├─ applyGate()     enable / disable filtering                          (unchanged)
  ├─ sortByGraph()   NEW — topological sort over inject → provides
  │                    · keys already bound on the app satisfy an inject with NO edge
  │                    · duplicate `provides`  → 'duplicate-provides'   ┐ before
  │                    · unsatisfiable inject  → 'unsatisfied-inject'   ├ ANY
  │                    · cycle                 → 'dependency-cycle'     ┘ import
  │                    · Kahn's algorithm; among simultaneously-ready nodes,
  │                      `order:` index first, then discovery order (total,
  │                      deterministic — never dependent on Map iteration)
  │
  ├─ for each plugin, in derived order:
  │    tryMount()    snapshot → app.component() → snapshot
  │                    · diff by binding INSTANCE identity      (already written)
  │                    · NEW: build the teardown FIRST, from the diff
  │                    · collision check                        (already written)
  │                    · NEW: on collision → RUN that teardown (rollback), then
  │                      return the error — a rejected mount leaves nothing behind
  │                    · NEW: on success → retain it; refcount component keys
  │                    · NEW: warn when a declared `provides` key was never bound
  │
  └─ report.uninstall()   composeTeardown().run()  — LIFO across mounts
         per mount, in reverse:
           · await stop() on each retracting lifeCycleObserver binding
           · for each touched key, ONE identity check drives BOTH halves:
               still ours?  → unbind, then restore the displaced binding
               not ours?    → skip BOTH (never restore over a third party)
           · a `components.*` key is unbound only when its refcount hits 0
```

### The identity check gates unbind *and* restore (eng review A1)

`unbindOwned` already refuses to unbind a key something else has since
rebound (`installed.ts:36-38`) — ownership, not key possession, is what an
inverse may retract. The restore half needs the *same* guard, because an
unguarded write is as destructive as an unguarded delete: if a third party
rebound the key after us, skipping the unbind but still re-adding the
displaced binding clobbers them, which is the exact bug the guard exists to
prevent. One check, both branches — never two independent checks that can
disagree.

### Shared nested components are refcounted (eng review A2)

`mountComponent` recurses into `component.components` (`component.ts:195-199`)
via `app.component()`, which **early-returns when the key is already bound to
the same constructor** (`application.ts:478-481`). So when plugin A and plugin
B both list `SharedComponent`, A mounts it and B's snapshot diff is **empty**
for those keys. Uninstalling A would unbind bindings B still depends on, and
the collision detector never fires because B never re-bound them.

The footprint therefore cannot come from the diff alone for component keys.
After each mount, resolve the plugin's component instance (already bound and
instantiated by `app.component()`), walk its `.components` array recursively,
and derive each nested key exactly as `application.ts:472-476` does —
`createBindingFromClass(c, {namespace: CoreBindings.COMPONENTS, …})`. Every
key on that walk takes a refcount **whether or not the mount bound it**, and
teardown unbinds a `components.*` key only when its count reaches zero.

The refcount map is per-`loadPlugins` run and dies with the report. A
component a constructor binds dynamically (not listed in `.components`) is
outside the walk — the same untracked-side-effect carve-out already recorded
under Known limits.

### A rejected mount leaves nothing behind (eng review X1)

`tryMount` mounts first and detects the collision second: `app.component()`
runs at `mount.ts:67`, the collision is computed at `:73-83`, and the error
returns at `:84-90`. Nothing undoes the mount. Under `strict: false` the
plugin is left **mounted but absent from `report.mounted`**, so no teardown
ever covers it — a leak that is invisible in the report, which is the one
artifact the package offers as its audit trail.

Since the teardown is now built from the same diff the collision check reads,
the fix is ordering: build it before checking, and run it on the error path.
A mount either fully happened and is retractable, or did not happen at all.

### Observers stop through the registry, not by hand (eng review X2)

`uninstall()` does not call `observer.stop()`. It goes through the lifecycle
registry, because a direct call bypasses `invokeMethod` method injection,
group ordering, disabled groups, and the `parallel` setting
(`lifecycle-registry.ts:153-165`).

It is also **gated on app state**: no observer is stopped unless the app is
`started` or `initialized`, mirroring `application.ts:406`. This replaces the
inherited "disposers are idempotent so either order is safe" assumption,
which does not hold here — the observers belong to third-party plugins, and
nothing makes a plugin author's `stop()` idempotent. Gating on state means
`app.stop()` then `uninstall()` cannot double-stop, without relying on
someone else's discipline.

### MCP tools are retracted, not just unbound (eng review X5)

Unbinding a controller already retracts its routes as 404 through the REST
controller liveness gate. MCP has no equivalent, and two things go wrong:
a built server keeps the unbound tool in its `visible` map, so `tools/list`
and `tools/call` still serve it; and `resolveMember` **falls back to
`new ctor()`** when the binding is gone (`mcp.server.ts:938-940`, whose own
comment reads "instantiate with no DI"). The net effect is an unmounted tool
that stays callable *and* runs without its injected dependencies.

Two changes in `@agentback/mcp`:

1. A per-dispatch liveness check mirroring the REST gate — a tool whose
   binding is gone is absent from `tools/list` and errors on `tools/call`.
2. **Remove the `new ctor()` fallback.** A missing binding must throw. The
   comment already concedes the branch is only reachable "for a class invoked
   without one"; silently running un-injected user code is a worse answer
   than a typed error, and after change 1 the branch is genuinely
   unreachable through the normal path.

### Reuse, not new machinery

| Existing | Location | Role here |
|---|---|---|
| `unbindOwned()` | `core/src/installed.ts:28` | Identity-guarded unbind — will not remove a binding something else has since shadowed |
| `composeTeardown()` | `common/src/utils/teardown.ts` | LIFO, idempotent, aggregates disposer failures |
| `Installed` | `core/src/installed.ts:11` | The interface the report now satisfies |
| binding snapshot diff | `plugin/src/mount.ts:65-83` | Already computed for collisions; now retained |
| `appOwnedContext()` | `plugin/src/mount.ts:29` | Already snapshots app-owned keys; now also the "satisfied by the app" set |
| `runInstallConformance` | `testing/src/install-conformance.ts` | `loadPlugin` runs through it directly |

### Two deliberate properties

**An `inject` satisfied by the app is not an ordering constraint.**
`appOwnedContext(app)` already snapshots every key bound before `loadPlugins`
runs. A plugin injecting a key the *application itself* bound is satisfied
with no graph edge — which is what makes binding-keys-only workable, since
not every dependency comes from a plugin.

**`provides` is checked against reality, and the check is a warning.** The
snapshot diff knows what a mount actually bound, so a plugin declaring a
`provides` key it never binds pushes a string onto `report.warnings` — not an
error, in either strict mode. Declarations govern ordering and early
detection; the container remains the authority.

**Ordering is a total, deterministic function of declared data.** Kahn's
algorithm over the `inject → provides` edges; among nodes that become ready
simultaneously, `order:` index wins, then discovery order. Two runs over the
same inputs always mount in the same sequence, and the result never depends
on `Map` iteration order.

**A partial strict load is retractable.** When `strict: true` throws
mid-load, the error already carries the populated report; that report's
`uninstall()` retracts the mounts that *did* succeed. Without this a strict
failure would leave a half-mounted app with no inverse, which is the exact
condition the substrate exists to remove.

## API surface

```ts
// types.ts
interface PluginPackageMarker {
  plugin: true;
  component: string;
  provides?: string[];   // NEW — binding keys this plugin contributes
  inject?: string[];     // NEW — binding keys it needs mounted first
}

interface PluginInfo {
  /* …unchanged… */
  provides: string[];    // NEW — normalized to [] when the marker omits it
  inject: string[];      // NEW — same
}

interface PluginLoadReport extends Installed {
  /* …unchanged fields… */
}

type PluginLoadErrorKind =
  | 'import' | 'missing-export' | 'not-a-component' | 'key-collision'
  | 'unsatisfied-inject'    // NEW
  | 'dependency-cycle'      // NEW
  | 'duplicate-provides';   // NEW

// load-plugin.ts — singular
function loadPlugin(
  app: Application,
  specifier: string,
  options?: LoadPluginOptions,
): Promise<PluginInfo & Installed>;   // was Promise<PluginInfo>
```

`LoadPluginOptions` and `PluginsConfig` are unchanged. `order:` survives as
the tiebreaker for genuinely independent plugins.

### File layout

| File | Change |
|---|---|
| `types.ts` | marker + `PluginInfo` gain `provides`/`inject`; report extends `Installed`; three error kinds |
| `discovery.ts` | `readMarker` reads and validates the two arrays; non-arrays or non-string entries are ignored with a warning (a malformed marker must not crash discovery, matching how an invalid marker is already skipped) |
| **`graph.ts`** | **new** — `sortByGraph(gated, appOwnedKeys, order)` → `{ordered, errors, warnings}`. Pure data → data: no `Application`, no imports, no I/O |
| `mount.ts` | `tryMount` returns `{touched, displaced}` on success; teardown construction |
| `load-plugins.ts` | wire the sort; collect per-mount teardowns; attach `uninstall` to the report |
| `load-plugin.ts` | return `PluginInfo & Installed` |
| `config.ts` | unchanged |
| **`mcp/src/mcp.server.ts`** | per-dispatch liveness check; **remove** the `new ctor()` fallback at `:938-940` so a missing binding throws |

`graph.ts` must honor `allowOverride` (eng review X3): two plugins may
legitimately declare the same `provides` key when the manifest lists it, so a
`duplicate-provides` error that ignores `allowOverride` would break a
currently-supported case and make the change non-additive.

Both `loadPlugin` and `loadPlugins` build their teardown through the **same**
`buildTeardown()` helper (eng review C1). The conditional-restore logic lives
there once; a second hand-rolled copy is the DRY violation that drifts.

`graph.ts` is separate because it is the one genuinely new algorithm and is
fully testable without an `Application`.

## Error handling and governance

Governance is unchanged: `strict`, `allowOverride`, and the auditable report
keep their semantics. The three new error kinds use the existing
`PluginLoadError` shape (naming the offending package) and flow through the
existing `fail()` path — collected under `strict: false`, thrown with the
populated report attached under `strict: true`.

One property improves. **Graph errors are detected before any import**, so a
strict failure throws with *zero* mounts performed. Today a collision throws
only after `app.component()` has already run its side effects. Undeclared
collisions still surface late via the snapshot diff — the declaration narrows
the window, it does not close it, and the diff remains the net.

A cycle error names **both** plugins and fails closed, rather than Cordis's
behaviour of leaving both components permanently inactive; fail-closed is
already this package's posture.

`uninstall()` failures aggregate rather than abort: `composeTeardown` catches
per-disposer, so a plugin whose observer `stop()` rejects does not strand the
remaining plugins' bindings. The caller sees one `AggregateError`.

## Testing

| Test | Proves |
|---|---|
| `graph.unit.ts` | order derivation; an app-satisfied `inject` adds no edge; unsatisfiable inject; cycle names both plugins; duplicate `provides`; `order:` tiebreak among independents; **an under-declared `inject` still mounts** (advisory, not enforced) |
| `mount.unit.ts` | displaced binding restored **by instance identity**, not merely "some binding exists at that key" |
| `unmount.acceptance.ts` | mount → `uninstall()` → routes 404 → **re-mount → routes live** |
| `loadPlugin` via `runInstallConformance` | the `Installed` contract on both the Express and fetch hosts, using a fixture plugin that contributes a controller |
| observer test | `stop()` is awaited on retraction; a rejecting `stop()` aggregates without stranding the rest |
| idempotency test | a second `uninstall()` is a no-op (inherited from `composeTeardown`, asserted here because it is now public contract) |
| strict-partial test | a `strict: true` failure mid-load throws, and the attached report's `uninstall()` retracts the mounts that already succeeded |
| **third-party rebind** | after the mount, something else rebinds a touched key: `uninstall()` must skip **both** the unbind and the restore — the single highest-value test here, since the naive implementation passes every other row |
| **collision rollback** | a colliding mount leaves **zero** bindings behind under both `strict: true` and `strict: false` |
| **shared nested component** | A and B both list `SharedComponent`; `A.uninstall()` leaves B fully working; only after both uninstall is it unbound |
| **observer gating** | no `stop()` on a never-started app; `app.stop()` then `uninstall()` does not double-stop; stop runs through the registry, honoring group order |
| **MCP retraction** | an unmounted `@mcpServer` disappears from `tools/list` **and** `tools/call` errors — never `new ctor()` |
| **allowOverride + duplicate provides** | two plugins declaring the same `provides` key mount cleanly when the manifest lists it in `allowOverride` |

**The re-mount leg is load-bearing, not a nicety.** `app.component()`
early-returns when the key is already bound to the same constructor
(`application.ts:479-481`) — it returns the existing binding *without
mounting*. If `uninstall()` fails to unbind the component's own
`components.X` key, a re-mount silently no-ops and the plugin reports as
mounted while contributing nothing. The snapshot diff does capture that key
(`this.add(binding)` happens inside the mount window), and this test is the
only thing that would catch a regression there.

All existing `@agentback/plugin` unit and acceptance tests must stay green.
Everything is additive except `tryMount`'s internal return type, which is not
exported.

## Out of scope (deliberately)

- **Reactive re-resolution.** No fibers, epochs, or provider hot-swap. A
  provider change remains a restart.
- **HMR.** The module cache is not rewound; a re-mount reuses the loaded
  module. Correct for toggling, insufficient for hot reload.
- **A per-plugin child `Context`.** Ownership stays detected (snapshot) plus
  declared (`provides`), not structural. Forking contexts changes resolution
  semantics for every existing plugin to reach the same two properties.
- **A new exported conformance suite.** `runInstallConformance` exists
  because ~11 `install*` helpers can each decay independently; there is
  exactly one plugin loader, so a shared suite would be ceremony. `loadPlugin`
  runs through the existing one instead.
- **Enforcing coeffects at access.** Cordis throws on reading an undeclared
  dependency; that needs the ambient Proxy context already logged as a
  non-takeaway. Under-declaring `inject` costs ordering guarantees, not
  correctness.
- **Softening fail-closed governance.** Part B adds an earlier, cheaper
  detection path to the same policy — it must not replace it.

## Known limits (stated, not discovered later)

- **Constructor/`init` side effects outside binding are untracked.** The
  preprint's own system boundary (§5.3): an effect that leaves the process
  can be withheld or compensated, never reverted.
- **Nominal keys have no versioning story.** `provides` entries are binding
  key strings; the preprint concedes the same gap (§6.6) with npm peer
  dependencies as the stopgap.
- **Bindings created lazily after a mount returns** (e.g. on first request)
  are outside any static footprint.
- **Declarations can go stale** (outside voice). `provides`/`inject` restate
  facts the code already expresses, and nothing forces them to agree. The
  mitigations are that the snapshot diff remains the authority for what was
  actually bound, and that a declared-but-never-bound `provides` warns. A
  stale declaration costs ordering accuracy, never correctness.
- **The graph cannot express "I need the overridden binding"** (eng review
  X4). When the app binds a default and a plugin overrides it, a consumer
  injecting that key is satisfied by the app's binding and gets **no edge** —
  so it may mount before the override lands. A consumer that needs the
  override must inject a key the overriding plugin uniquely provides. Adding
  override-awareness to the graph would mean modelling binding precedence,
  which is the container's job, not the manifest's.

## Documentation surfaces

Per `CLAUDE.md`'s doc-surface rule, the implementation must also update
`packages/plugin/README.md`, `docs/packages.md`, the `skills/agentback`
reference page, `CLAUDE.md`'s capability list, and `examples/hello-plugin`.
Those belong in the implementation plan, not this spec.

## References

- [docs/proposals/plugin-composability.md](../../proposals/plugin-composability.md) — the proposal this implements
- [docs/proposals/revertible-installs.md](../../proposals/revertible-installs.md) — the shipped substrate
- [docs/proposals/cordis-spatiotemporal-composability.md](../../proposals/cordis-spatiotemporal-composability.md) — research note the two axes come from
- [docs/superpowers/plans/2026-06-04-plugin-loader.md](../plans/2026-06-04-plugin-loader.md) — the original loader plan

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | RAN (codex) | 9 findings, 2 duplicated the Claude pass |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 11 issues, 0 critical gaps, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 9 findings. 2 independently matched the Claude pass (unguarded
restore; shared-nested-component footprint) — cross-model agreement, both
already folded. 4 new and accepted (collision rollback, observer stop
mechanism, `allowOverride` vs `duplicate-provides`, app-default vs override
injects). 1 new and accepted with scope expansion (MCP retraction). 1
rejected by the user (drop Part B). 1 absorbed as a Known limit (declaration
staleness).

**CROSS-MODEL:** Both reviewers independently found that `unbindOwned`'s
identity guard covers only the unbind, and that `app.component()`'s
early-return empties the second plugin's footprint for a shared nested
component. Neither found the other's remaining items, which is why both ran.

**VERDICT:** ENG CLEARED — ready to implement.

NO UNRESOLVED DECISIONS
