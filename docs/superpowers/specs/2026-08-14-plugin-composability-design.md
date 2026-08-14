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
| 6 | Does `app.stop()` uninstall plugins? | No — independent lifecycles | Inherited unchanged from `revertible-installs.md`; disposers are idempotent so either order is safe. |

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
  │                    · collision check                        (already written)
  │                    · NEW: retain {touched, displaced}; push a teardown
  │                    · NEW: warn when a declared `provides` key was never bound
  │
  └─ report.uninstall()   composeTeardown().run()  — LIFO across mounts
         per mount, in reverse:
           · await stop() on each retracting lifeCycleObserver binding
           · unbindOwned(key) for every touched key             (already written)
           · re-add the displaced binding where one existed (the allowOverride case)
```

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
