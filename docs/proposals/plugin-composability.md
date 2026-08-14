# Proposal: plugin composability — unmount, and a declared dependency graph

**Status:** Draft, August 2026. Successor to two follow-ups already named in
the repo; nothing here is new vocabulary.
**Sources:** [revertible-installs.md](revertible-installs.md) (shipped),
[cordis-spatiotemporal-composability.md](cordis-spatiotemporal-composability.md)
(research note — Cordis v4 source read + the PKU/DeepSeek preprint).

## Why now

The research note frames dynamic composition on two axes: **temporal**
(removing a component reverts its effects) and **spatial** (components
declare dependencies the runtime resolves). Its takeaway #1 took the cheapest
20% of the temporal axis — _mount functions return their inverse_ — and named
`@agentback/plugin` as where it mattered most. That became
`revertible-installs.md`, which shipped, and which deliberately scoped itself
as "the substrate `@agentback/plugin` composes" rather than a plugin redesign.

Its own follow-ups defer the rest here by name: per-mount handles "ride the
`@agentback/plugin` unmount wave", and conformance depth is held "when plugin
unmount lands". The substrate exists now. This is that wave.

The spatial axis was studied in the note but never reduced to an actionable
takeaway. Part B does that, at the same discount rate: the cheapest static
20%, no reactivity.

## Part A — temporal: `report.uninstall()`

Today a mount is one-way. The README says so plainly: `loadPlugin` "is **not
idempotent**: mounting the same plugin twice trips the collision guard."

**The footprint is already computed and then thrown away.** `tryMount`
snapshots every binding before and after `app.component()` and diffs them by
_binding instance identity_, not key presence, precisely so an override is
distinguishable from a fresh bind (`mount.ts:14`, `mount.ts:65-83`). That diff
_is_ the set of keys a mount touched. It is currently read once for collision
detection and discarded.

Retain it:

- `tryMount` returns the touched keys plus the prior `Binding` instance for
  each — the snapshot already holds both, so restore is expressible today.
- `loadPlugins` composes per-mount teardowns with `composeTeardown()`
  (LIFO, `@agentback/common`) into `report.uninstall()`.
- Each teardown unbinds keys the mount created, and **restores** the prior
  binding for keys it re-bound under `allowOverride`. Unbind and restore are
  different operations; conflating them would silently delete a first-party
  binding a plugin was permitted to shadow.
- `loadPlugin` (singular) returns `PluginInfo & Installed`.

What this buys with no new machinery: unbinding a controller **already**
retracts its routes as 404 on both hosts via the per-request
`findControllerBindingKey` gate that the revertible-install work landed. So a
plugin contributing controllers becomes genuinely retractable the moment its
bindings are. Downstream: mount→unmount→re-mount (the non-idempotence above
disappears by composition), per-test plugin isolation, a console toggle, dev
reload.

### Carve-outs

Inherited honesty from the substrate proposal, plus two of our own:

- **A Component contributes more than bindings.** `lifeCycleObservers` and
  `servers` are registrations whose key-unbind does not run their `stop()`.
  v1 must either refuse to unmount a component that bound a lifecycle
  observer while the app is started, or run observer `stop()` on unmount.
  Lean: the latter, under the same idempotent-disposer discipline the
  substrate already requires.
- **Constructor/`init` side effects outside binding are untracked.** This is
  the system-boundary limit the preprint concedes (§5.3): an effect that
  emits beyond the process can be withheld or compensated, never reverted.
- **The module cache is not rewound.** `import()` is not undone, so a
  re-mount reuses the loaded module. Correct for toggling, insufficient for
  HMR — see "What this is not".

## Part B — spatial: static `provides` / `inject` in the marker

Ordering is manual today. `order: []` is a mount-order prefix the operator
maintains by hand (`config.ts:14`, `gate.ts:59-66`), and it is the only lever.
That is exactly the "manual boot sequencing" a declared graph exists to
delete.

The cheap version needs no reactivity, because **discovery already reads the
marker off disk without importing the package** (`discovery.ts:49`). Extend
the stanza:

```jsonc
"agentback": {
  "plugin": true,
  "component": "MyComponent",
  "provides": ["services.Catalog"],
  "inject": ["services.Auth"]
}
```

Three properties fall out, all static, all before any plugin code runs:

1. **Derived order.** Topologically sort the gated set by `inject → provides`.
   `order:` degrades to a tiebreaker for the genuinely independent remainder
   instead of being the primary mechanism.
2. **Pre-import collision detection.** Two plugins declaring the same
   `provides` key is detectable before either is imported. Today collision is
   a post-hoc diff (`mount.ts:71-83`) — you learn that a plugin re-bound an
   auth strategy _after_ `app.component()` already ran its side effects.
   Declaration moves the common case ahead of the side effect; the snapshot
   diff stays as the net for undeclared bindings, which is the case a
   declaration can never catch.
3. **An unsatisfiable graph is a load error.** A plugin injecting a key
   nothing provides and the app has not bound fails in the report, named,
   rather than surfacing as a resolution failure at `app.start()`.

**Declarations are advisory, not enforced at access.** Cordis enforces
coeffects at property read — an undeclared `ctx.database` throws — but that
requires the ambient Proxy context the research note already logs as a
non-takeaway (stringly-namespaced services, no request scope, per-access
proxy allocation). Here the DI container stays the authority at resolution
time, and under-declaring `inject` costs you ordering guarantees, not
correctness. That asymmetry is the whole reason this half is cheap.

Two limits worth stating rather than discovering:

- **Nominal keys have no versioning story.** `provides` entries are binding
  key strings; the preprint concedes this same gap (§6.6) with npm peer
  dependencies as the stopgap. It applies here verbatim.
- **Cycles fail closed.** A cycle in the declared graph is a load error
  naming both plugins — not Cordis's "both remain permanently inactive",
  because fail-closed is already this package's posture.

## What this is not

- **Not reactive re-resolution.** No fibers, epochs, or provider hot-swap. A
  provider change remains a restart. The note's non-takeaway stands: adopting
  the fiber/epoch machinery wholesale would be a second framework inside the
  framework.
- **Not HMR.** The module cache is untouched.
- **Not a `Context` fork per plugin.** Ownership stays _detected_ (snapshot)
  plus _declared_ (`provides`), not structural. Per-plugin child contexts
  remain the end-state the note describes; they change resolution semantics
  for every existing plugin, which is not worth it to reach the same two
  properties.
- **Not a change to governance.** `strict`, `allowOverride`, and the
  auditable report are unchanged. Part B adds an earlier, cheaper detection
  path to the same policy — it must not soften it. Cordis's plugin model is
  cooperative; ours is adversarial by design, and that is the part with no
  Cordis equivalent to borrow.

## Verification

- A plugin conformance suite paralleling `runInstallConformance`:
  mount → uninstall → routes 404 → re-mount → routes live.
- **Override restore**, by instance identity: B overrides A's key under
  `allowOverride`; after `uninstall()`, A's original `Binding` object is back
   — not merely _a_ binding at that key.
- Ordering: a fixture set whose discovery order is deliberately wrong and
  whose declared graph is right.
- Unsatisfiable graph and cycle: collected into `report.errors` under
  `strict: false`, thrown under `strict: true`, both naming the plugins.

## Open questions

1. `uninstall()` on the report, or a separate `{report, uninstall}` return?
   The report is a record; hanging a capability off it conflates the two.
   (Lean: on the report — additive, and it matches the `install*` precedent of
   putting the inverse on the returned thing.)
2. Does `app.stop()` uninstall plugins? Inherit the substrate's answer:
   independent lifecycles, disposers idempotent so either order is safe.
3. Should `inject` accept a plugin _name_ as well as a binding key?
   (Lean: keys only. Names would reintroduce exactly the nominal
   plugin-to-plugin coupling that injecting a key avoids.)
