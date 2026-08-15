# Proposal: agent-authored plugins — mount what you just wrote

**Status:** Draft, August 2026. Successor to
[plugin-composability.md](plugin-composability.md), which shipped.
**Sources:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(released 2026-08-13, Cordis as its kernel), the
[Spatiotemporal Composability preprint](https://github.com/cordiverse/paper),
and the research note
[cordis-spatiotemporal-composability.md](cordis-spatiotemporal-composability.md).

## Why now

DeepSeek Harness shipped a "creation mode": the agent inspects its own running
plugin tree and mounts or unmounts temporary plugins while serving. It is off
by default, its trust level is documented as equivalent to shell access, and
the temporary plugins live in process memory only. That is the first product
shape of the workload the preprint names as its motivation, and it is a useful
forcing function for asking what AgentBack would need to host the same thing.

Most of the substrate is already here. Retraction landed with
`plugin-composability.md`: every `install*` returns an `Installed`,
`loadPlugins` returns a report that satisfies it, a rejected mount rolls back,
and shared components are refcounted. Fail-closed collision governance has been
here since the loader shipped, and has no Cordis equivalent — a plugin that
re-binds a first-party key halts startup unless the manifest allow-lists it.
`@agentback/introspection` already gives an agent a read-only view of the app,
and `@agentback/agents` already lets it call the app's own tools.

Two capabilities are missing, and both are small.

## The gap, precisely

**An agent that writes a `Component` at runtime has no governed way to mount
it, and no way to see what is mounted.**

`loadPlugin(app, specifier, options)` takes a **string** and resolves it
against the filesystem or the npm graph (`load-plugin.ts`, `resolvePlugin`).
There is no overload that accepts a class.

`Application.component(ctor)` takes a class and mounts it, but it is
**ungoverned**: no collision detection against other plugins, no `Installed`
handle, no participation in the component refcount. Using it for an
agent-authored component gives up every guarantee the loader exists to provide.

`report.mounted` is a **return value**, not queryable state. Nothing bound on
the app answers "what is mounted right now?", and the component refcounts live
in a module-level `WeakMap` (`mount.ts`, `componentRefs`). An agent that wants
to inspect the plugin tree before changing it has nothing to read.

`@agentback/introspection` inventories `binding`, `route`, `tool`, and
`schema-entity` (`introspection/src/model.ts`). There is no `plugin` kind, so
the agent sees every binding a plugin contributed without seeing the plugin.

## Scope

Three changes, in dependency order. Each is independently useful.

### G1 — a governed mount that takes a class

```ts
import {mountComponent} from '@agentback/plugin';

const handle = await mountComponent(app, MyComponent, {
  name: 'agent:scratch-1', // identity in the ledger and the registry
  allowOverride: ['services.Cache'],
});
await handle.uninstall();
```

`tryMount` already does exactly this work on a class; it just reaches the class
by `await import(specifier)` first. Split it:

```text
tryMount(app, info, ctx, refs)
  ├── resolve: await import(info.importSpecifier) -> ctor      ← disk/npm only
  └── mountResolved(app, name, ctor, ctx, refs)                ← the governed half
        snapshot -> app.component(ctor) -> snapshot
        diff by binding identity, collision check, rollback on reject,
        component refcount, footprint, teardown
```

`loadPlugin` and `loadPlugins` keep calling both halves. `mountComponent` calls
only the second, with `source: 'memory'`. Every governance property comes along
unchanged, because it all lives in `mountResolved`.

The `name` is required rather than derived from the class, because two
agent-authored components can share a class name across turns and the owners
ledger keys on the plugin name.

### G2 — a live plugin registry

```ts
export interface MountedPlugin {
  name: string;
  version: string;
  component: string;
  source: 'deps' | 'dir' | 'memory';
  provides: string[];
  inject: string[];
}

export interface PluginRegistry {
  mounted(): MountedPlugin[];
  /** components.* key -> how many live mounts reference it */
  componentRefs(): ReadonlyMap<string, number>;
}

PluginBindings.REGISTRY; // BindingKey<PluginRegistry>, key 'plugins.registry'
```

The refcounts move out of the module-level `WeakMap` and onto this binding, so
the same state that governs retraction is the state an operator or an agent can
read. `uninstall()` removes the entry.

**The registry binding must be created outside any mount window.** Bind it
before `appOwnedContext(app)` snapshots, or the first mount's binding diff will
contain it, the registry becomes part of that plugin's footprint, and
uninstalling that plugin unbinds the registry underneath everything else. This
is the same shape as the bugs `plugin-composability.md` already documents, and
it is why it is called out here rather than discovered later.

### G3 — a `plugin` introspection kind

Add `plugin` to `IntrospectionKind` and emit one node per `MountedPlugin`, with
`provides`/`inject` as edges to the binding nodes that already exist. The
builders are read-only and stay read-only.

## What this is not

- **Not a write surface on `@agentback/introspection`.** That package is
  committed to read-only forever: it never invokes a route or tool and never
  resolves a secret-bearing binding. Mounting is a write. It belongs on a
  separate, explicitly-privileged surface with its own trust gate — which is
  how Harness structures it, as a preset that is off by default and documented
  as equivalent to shell access.
- **Not a sandbox.** Nothing here restricts what an agent-authored component
  can do once mounted. See "Not in scope" below.
- **Not hot swap.** No reactive re-resolution, no fibers, no HMR. A provider
  change is still a restart.
- **Not a persistence story.** A memory-sourced plugin is gone on restart, by
  construction. Persisting one is writing a package, which is the existing
  path.

## Built after this proposal

**The provider-outlives-consumer guard.** Retracting a plugin whose `provides`
key another live plugin declares in `inject` now throws
`PluginRetractionBlockedError` naming both, before any teardown work. LIFO
composition already gave that ordering within one report; the guard covers
independent handles.

Cordis spends an `UNLOADING` lifecycle state and a guarded two-phase rule on
the same problem, with a progress theorem. That machinery buys the ability to
keep serving through the transition, which is only worth its weight next to the
reactive re-resolution we deliberately do not have. Where a provider change is
a restart, a declarative check gets the same safety property for a fraction of
the surface. It reads the same advisory declarations as the graph, so an
under-declared `inject` is invisible to it, which is pinned by a test.

## Not in scope, and why each is separate

**The provider-outlives-consumer guard — built (2026-08-15), see below.**

**Per-plugin capability restriction — decided out of scope (2026-08-15).** Interceptors in this codebase wrap
_method invocations_ (`InterceptedInvocationContext`, keyed on `targetName`),
not _dependency resolutions_. There is no way to say "this community plugin
resolves `FileStore` to a path-restricted view while first-party code gets the
full one." Cordis calls the equivalent coeffect interception and attaches it to
the context rather than to either party, so an orchestrator can adjust it
without editing provider or consumer. Adding that is a new seam in the
container and a real project.

It also would not make hosting untrusted code safe. The preprint concedes that
language-level access control does not hold against a malicious component and
that real isolation needs an execution boundary outside the language. Closing
this gap buys defense-in-depth against mistakes, not safety against attacks.

**Decision: not building it.** Plugins are trusted code — first-party or
vendored. This package governs collisions, ordering and lifecycle, and the
boundary for code you do not trust is a process or a container, not a DI
container. Recorded in `packages/plugin/README.md` under "Plugins are trusted
code" so a reader hits it where they would otherwise infer an unfinished
feature. Narrowing what a plugin resolves, by binding a restricted port
implementation into a child context, stays available and stays a way to limit
mistakes rather than a security control.

## What this unlocks that Harness does not have

An agent-authored `@tool` in AgentBack projects to REST, MCP, the operator CLI,
the agent surface, and the OpenAPI document from one Zod schema. A
plugin-contributed tool in a Cordis host is a tool. Here the agent writes one
contract and every consumer of the process sees it, including the OpenAPI
document that a _different_ agent reads. That is boundary coherence applied to
a component that did not exist when the process started.

## Verification

- `mountComponent` runs the existing plugin conformance cycle: mount, serve,
  uninstall, 404, re-mount, serve.
- A collision between an agent-authored component and a disk plugin is rejected
  and rolled back, exactly as two disk plugins are today.
- A memory plugin and a disk plugin sharing a nested `Component` refcount
  together, since they go through one `mountResolved`.
- Uninstalling the first-mounted plugin does not unbind the registry.
- `introspection` reports a memory-sourced plugin with its `provides`/`inject`,
  and reports nothing after it is retracted.

## Open questions

1. ~~Should `mountComponent` be in `@agentback/plugin`, or in a new package
   that carries the trust gate with it?~~ **Resolved (2026-08-15):**
   `@agentback/plugin`, and no agent-callable tool ships at all. Shipping one
   would ship a default answer to "who may rewrite this process". The README
   carries it as a recipe instead, including the part the recipe deliberately
   does not do: turn agent-written text into a class. `mountComponent` takes a
   constructor, so producing one from source is an evaluation step the caller
   owns, and its trust level is the process's trust level.
2. Does a memory plugin appear in `report.mounted` of a later `loadPlugins`
   call, or only in the registry? (Lean: registry only. The report is the
   record of one discovery run.)
3. Is `name` collision across agent turns an error or an implicit replace?
   (Lean: error. Implicit replace is the silent-override failure this package
   exists to prevent.)
