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
