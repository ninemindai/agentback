# @agentback/plugin

Discover, gate, and mount `Component`-contributing plugins into an AgentBack
`Application`.

```ts
import {Application} from '@agentback/core';
import {loadPlugins} from '@agentback/plugin';

const app = new Application(config);
await loadPlugins(app); // discover (deps + dirs) -> gate -> mount -> report
await app.start();
```

`loadPlugins` is a standalone async bootstrapper: call it once, after constructing
the app and before `app.start()`. It does not subclass or wrap the app — it reads
a manifest, discovers plugins, mounts each plugin's `Component` via the normal
`app.component()`, and returns an auditable report.

## Imperative: `loadPlugin(app, specifier)`

When you want to mount **one** specific plugin — by npm package name or
filesystem path — rather than discover from the dependency graph, use the
singular `loadPlugin`. Unlike `loadPlugins`, the target need not be a declared
dependency and need not carry an `agentback` marker:

```ts
import {loadPlugin} from '@agentback/plugin';

// A marked package (npm name) — marker names the component export:
await loadPlugin(app, '@acme/foo');

// A local directory (relative to cwd) — marker or {component}:
await loadPlugin(app, './plugins/foo');

// An UNMARKED package or bare file — name the export explicitly:
await loadPlugin(app, './plugins/bare.js', {component: 'MyComponent'});
```

`loadPlugin` returns the mounted `PluginInfo` and **throws** on failure
(unresolvable specifier, missing named export, or a DI-key collision). It shares
the exact governance of `loadPlugins`: re-binding a key the app already owns
throws unless you pass it in `options.allowOverride`.

```ts
interface LoadPluginOptions {
  component?: string; // required for unmarked targets; overrides the marker
  allowOverride?: string[]; // DI keys this mount may intentionally re-bind
  cwd?: string; // base dir for relative paths / bare-specifier resolution
}
```

Use `loadPlugins` (plural) for the declarative manifest path; use `loadPlugin`
(singular) for an explicit, code-driven mount of a known target.

`loadPlugin` returns an `Installed` — see [Unmounting](#unmounting). Mounting
the same plugin twice is **refcounted**, not an error: `app.component()`
early-returns for a component already bound to the same class, so the second
mount binds nothing new and simply takes a second reference. Each call returns
its own handle, and the plugin is retracted when the **last** one uninstalls.

## Unmounting

Both entry points return their inverse, per the
[revertible-install contract](../../docs/proposals/revertible-installs.md):

```ts
const report = await loadPlugins(app);
await report.uninstall(); // retracts every plugin that mounted, LIFO

const one = await loadPlugin(app, '@acme/foo');
await one.uninstall(); // PluginInfo & Installed
```

`uninstall()` is idempotent, and retracts:

- **bindings** the mount added — and **restores** any it displaced under
  `allowOverride`;
- **lifecycle observers**, through the lifecycle registry (so group order,
  `disabledGroups` and the `parallel` setting all hold), and only while the app
  is `started`/`initialized`;
- **routes**, as a consequence: unbinding a controller makes its routes 404 on
  both hosts.

Six behaviors worth knowing, each of which exists because the naive version is
wrong:

- **Ownership, not key possession.** If something else re-bound one of the
  plugin's keys after it mounted, `uninstall()` touches neither the unbind nor
  the restore. An unguarded restore would clobber that third party exactly as
  an unguarded unbind would delete it.
- **A provider outlives its consumers.** Retracting a plugin whose
  `provides` key another live plugin still declares in `inject` is refused,
  naming both. A consumer's own teardown routinely needs the dependency it is
  losing, so this is not tidiness. LIFO composition already gives the ordering
  inside one report; the guard is what covers independent handles. It reads
  the same advisory declarations as the graph, so an under-declared `inject`
  is invisible to it.
- **Idempotent means idempotent.** A handle memoizes its inverse, so repeat
  calls change nothing. This is load-bearing rather than cosmetic: a rebuilt
  teardown would decrement a shared component's refcount a second time and
  retract it under a plugin that still holds it.
- **A failing observer still gets you a clean retraction.** If a plugin's
  `stop()` rejects, the bindings are still reverted and the error surfaces as
  an `AggregateError`. Bailing out early would leave them mounted with no
  record of who owns them — worse than the original failure.
- **A rejected mount leaves nothing behind.** `app.component()` runs its side
  effects before a collision is detectable, so a losing plugin is rolled back
  rather than left bound and absent from `report.mounted`.
- **Shared nested components are refcounted, per application.** Two plugins
  listing the same nested `Component` both keep it alive; it is retracted by
  whichever uninstalls last, not by whichever mounted it first.
- **A partial `strict` load is still retractable.** The thrown error carries
  the report, and that report's `uninstall()` retracts the mounts that did
  succeed.

Not retracted: side effects that already left the process, and anything a
component's constructor did beyond binding.

## Mounting a class you wrote at runtime

`loadPlugin` resolves a specifier against disk or npm, which assumes a human
with a filesystem. `mountComponent` takes the class directly and applies the
same governance:

```ts
import {mountComponent} from '@agentback/plugin';

const handle = await mountComponent(app, MyComponent, {
  name: 'agent:scratch-1', // identity in the ledger and the registry
  allowOverride: ['services.Cache'],
});
await handle.uninstall();
```

Collision detection, rollback on rejection, component refcounting and
retraction are the same code paths a package on disk takes, because everything
that makes a mount safe lives after the import and both entry points share it.
`name` is required rather than derived from the class: two components authored
in different turns can share a class name, and the owners ledger keys on it.

Mounting is a write, so this is deliberately **not** on the read-only
introspection surface. Whatever exposes it as an agent-callable tool owns the
trust gate.

## What is mounted right now

`PluginBindings.REGISTRY` is live state, where a `PluginLoadReport` is the
record of one discovery run:

```ts
const registry = app.getSync(PluginBindings.REGISTRY);
registry.mounted(); // MountedPlugin[] — name, version, component, source, provides, inject
registry.componentRefs(); // components.* key -> live reference count
```

`source` is `deps`, `dir`, or `memory`. Entries disappear as plugins retract.
`@agentback/introspection` exposes the same data as its `plugin` kind, so an
agent can inspect the tree before changing it.

## Declaring dependencies

A plugin can declare which DI keys it contributes and which it needs:

```jsonc
"agentback": {
  "plugin": true,
  "component": "MyComponent",
  "provides": ["services.Catalog"],
  "inject": ["services.Auth"]
}
```

Mount order is then a topological sort over `inject → provides`, and `order:`
becomes a **tiebreaker** among plugins that are otherwise independent. With no
declarations anywhere there are no edges, so `order:` alone governs — exactly
as before this existed.

Because discovery reads the stanza off disk without importing anything, three
checks run **before any plugin code executes**: a duplicate `provides` (unless
the key is in `allowOverride`), an `inject` nothing provides, and a cycle. Each
fails with the plugins named.

A **typo'd marker key is reported, not swallowed** — `provide` for `provides`
lands in `report.warnings` naming the key, because a silently-dropped
declaration leaves you debugging an ordering problem with no visible cause.
Print `report.warnings`.

When several plugins declare the same `provides` key under `allowOverride`, a
consumer injecting it is ordered after **every** one of them — edging only to
the last declarer would let an earlier provider mount afterwards and overwrite
the binding the consumer was ordered to wait for.

Declarations are **advisory**. They govern ordering and early detection; the DI
container remains the authority at resolution time, so under-declaring `inject`
costs you ordering guarantees, not correctness. Two consequences: a key the
**application itself** binds satisfies an `inject` with no edge (not every
dependency comes from a plugin), and the graph cannot express "I need the
_overridden_ binding" when the app holds a default — a consumer that needs the
override should inject a key the overriding plugin uniquely provides.

A runnable end-to-end demo of both entry points lives in
[`examples/hello-plugin`](../../examples/hello-plugin).

## Making a package a plugin

Add one stanza to the package's `package.json`. The named export must be a
`Component` on the package's main module (it already is, if you `export` your
component from the package root):

```jsonc
"agentback": {"plugin": true, "component": "MyComponent"}
```

Discovery reads this stanza off disk, so it never imports a package just to learn
whether it is a plugin.

## Manifest

Populate `PluginBindings.CONFIG` on the app, or pass `options.config` to
`loadPlugins`. Both are validated by the `PluginsConfig` Zod schema.

```jsonc
{
  "scan": true, // discover from declared npm deps (default true)
  "dirs": ["./plugins"], // also scan these dirs for marked packages (default [])
  "enable": ["@acme/foo"], // allowlist - if present, ONLY these mount
  "disable": ["@acme/bar"], // subtract from the discovered set
  "order": ["@acme/foo"], // mount-order prefix; the rest follow discovery order
  "allowOverride": ["services.X"], // DI keys a plugin may intentionally re-bind
  "strict": true, // fail-closed (default): a broken plugin or DI-key
  // collision HALTS startup
}
```

### Two discovery sources, one gate

- **`scan`** resolves each declared dependency's package directory and reads its
  `package.json` marker off disk.
- **`dirs`** scans each directory's immediate subdirectories for marked packages
  (local / dropped-in plugins that are not npm dependencies).

Both feed one candidate set, which `enable` / `disable` / `order` then filter and
order.

### Fail-closed by default

`strict` defaults to `true`. A plugin that fails to import, is missing its named
export, or re-binds a DI key already owned by another plugin (and not listed in
`allowOverride`) halts startup. The thrown error still carries the populated
report. Set `strict: false` to collect every failure into the report and keep
mounting the rest — useful for development or lenient third-party hosting.

### Why DI-key collisions are first-class

A third-party plugin silently overriding a first-party binding (an auth strategy,
an enforcement point) is the failure a governance substrate cannot have. The
loader snapshots the context's bindings around each mount and flags any key a
later plugin re-binds, so an override is never silent. This protects keys bound
by the application itself (before `loadPlugins`) as well as keys bound by an
earlier plugin — to re-bind either on purpose, list the key in `allowOverride`.

## The report

`loadPlugins` returns a `PluginLoadReport` — the synchronous, testable record of
what happened:

```ts
interface PluginLoadReport {
  discovered: PluginInfo[]; // everything found by either source
  mounted: PluginInfo[]; // actually mounted, in mount order
  skipped: Array<PluginInfo & {reason: 'disabled' | 'not-enabled'}>;
  warnings: string[]; // non-fatal: undiscovered enable/order name, missing dir
  errors: PluginLoadError[]; // import / missing-export / key-collision
}
```

The `discover` scanner is also exported on its own, so a console or control plane
can list what _would_ mount without mounting anything.
