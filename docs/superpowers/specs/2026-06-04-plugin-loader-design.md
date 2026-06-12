# Plugin Loader (`@agentback/plugin`) — Design

**Date:** 2026-06-04
**Status:** Approved design; ready for implementation planning.

## Problem

Composing an AgentBack app is fully manual today. Each app's `index.ts`
hand-imports component classes and calls `app.component(MCPComponent)`,
`app.component(AgentOrchestrationComponent)`, … one per line. The 15 `agent-*`
packages each export a `Component` that bundles services/controllers/servers,
but **nothing discovers or mounts them** — the app author enumerates them by
hand and is responsible for getting the set right.

This blocks two things downstream tooling needs:

1. **Generated-assembly.** A code generator produces server/route pieces (MCP
   servers, enforcement points, routes) and needs a deterministic, auditable way
   for the customer-owned app to mount them.
2. **Third-party / tenant extension.** A tenant (or third party) ships a package
   that contributes a `Component`; the app should discover and mount it without
   the app author editing `index.ts`.

Both are served by **one loading mechanism with two authors** (a generator
authors the produced pieces as plugin(s); third parties author others), at two
trust levels gated by a manifest.

## Non-goals (v1)

- **No code sandboxing / process isolation.** Plugins run in-process with full
  DI access. The manifest entry _is_ the trust decision. Isolation is a later
  rung, not a v1 blocker.
- **No capability scoping.** Plugins receive the normal application context, not
  a restricted one. (Future rung.)
- **No explicit inter-plugin dependency declarations** (`dependsOn`). Dependencies
  are expressed through DI bindings/keys, as they already are; the container
  resolves them. See "Why ordering is not the loader's problem".
- **No MCP HTTP/SSE transport changes, no new enforcement engine.** Out of scope.

## Decisions locked during brainstorming

| Dimension    | Decision                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------- |
| Purpose      | Generated-bridge mount surface **and** third-party extension SDK (one contract, two authors) |
| Discovery    | Manifest + convention hybrid (scan discovers candidates; manifest gates/orders activation)   |
| Trust (v1)   | In-process; the manifest entry is the trust gate                                             |
| Plugin shape | Bare `Component` export; dependencies resolved via DI                                        |
| Form factor  | Standalone async bootstrapper: `await loadPlugins(app, options?)`                            |

## Decisions locked during eng review (2026-06-04)

| Decision            | Choice                                                                   | Why                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Failure mode        | **Fail-closed** (`strict: true` default)                                 | A silently-skipped enforcement plugin is the failure a governance substrate can't have                                                     |
| Key collisions      | **Detect + fail-closed**, `allowOverride` escape hatch                   | `context.add()` only throws on _locked_ bindings — without a key diff, a third-party plugin silently overrides first-party bindings        |
| Local plugins       | **In scope** — scan a `plugins/` dir (`dirs` config)                     | Most faithful to the `loopback-boot` instinct; covers the tenant "drop a dir" case; shares the disk-read + marker logic with dep discovery |
| Discovery mechanism | `import.meta.resolve` + walk-up + **disk read**                          | `import('pkg/package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` against the restrictive `exports` maps every `agent-*` package ships   |
| Audit vs test       | `PluginLoadReport` is the testable contract; audit **event** is additive | Lets the audit-transport decision defer without blocking the test plan                                                                     |

## Why ordering is not the loader's problem

Two facts about core make "mount in any order, let DI sort it out" correct rather
than hand-wavy:

1. **`mountComponent` only _registers_ bindings — it resolves nothing.** It calls
   `app.add` / `app.controller` / `app.server` / `app.service` / `app.lifeCycleObserver`,
   all lazy. So **mount order is irrelevant for `@inject`**: as long as every
   plugin is mounted before `app.start()`, the container resolves the dependency
   graph on demand. (Verified in `packages/core/src/component.ts`.)
2. **Start order is a separate concern already solved by core.**
   `LifeCycleObserverRegistry` orders observers by _group_
   (`orderedGroups` + `@lifeCycleObserver(group)` tags). "Redis connects before
   the loop's server starts" is expressed as lifecycle groups, **not** plugin
   mount order. The loader never needs to know about it.
   (Verified in `packages/core/src/lifecycle-registry.ts`, `lifecycle.ts`.)

Consequence: the loader is thin — **discover → gate by manifest → `import()` →
`app.component()`**. All the ordering hard-parts already live in core.

## Form factor

A standalone async function, because discovery needs `await import()` and
`app.component()` is synchronous:

```ts
const app = new AgentApplication(config);
await loadPlugins(app); // manifest + scan + mount + audit
await app.start();
```

Rejected alternatives:

- **`PluginMixin` (the `loopback-boot`/`BootMixin` analog).** Forces an app
  subclass and reintroduces upstream's "async boot bolted onto sync
  construction" awkwardness. A standalone function composes with any app and puts
  async where it belongs.
- **Self-hosting `PluginComponent`.** `app.component()` is sync, so a component
  cannot `await import()` its children — it would force eager/sync requires and
  kill the convention-scan discovery. Rejected.

## 1. Plugin contract + convention marker

A plugin is a package that **already exports a `Component`**. It becomes
discoverable by adding one stanza to its `package.json`:

```jsonc
// e.g. @agentback/agent-loop/package.json
{
  "agentback": {
    "plugin": true,
    "component": "AgentLoopComponent", // names the export to mount
  },
}
```

- The scanner keys off `agentback.plugin === true`.
- The loader reads `agentback.component` to know **which named export** to
  pull from the module.

**Why a named export, not default-export guessing.** In ESM, packages routinely
have many exports and often no default. Naming the export in `package.json` keeps
the plugin a bare `Component` export while making discovery deterministic — the
scan can report exactly what will mount **without importing and executing** the
module. That static-auditability matters for a governance product.

### Types

```ts
// package.json "AgentBack" stanza, validated by Zod
export interface PluginPackageMarker {
  plugin: true;
  component: string; // named export that is a Component subclass/impl
}
```

## 2. Manifest (the gate)

Lives as a `plugins` section in app config (reuses `@agentback/config`),
Zod-validated. Convention scan discovers candidates; the manifest gates/orders
which are actually mounted.

```jsonc
{
  "plugins": {
    "scan": true, // discover from declared npm deps (default true)
    "dirs": ["./plugins"], // also scan these dirs for marked packages (default [])
    "enable": ["@acme/tenant-plugin"], // optional allowlist — if present, ONLY these mount
    "disable": ["@agentback/agent-redis"], // subtract from the discovered set
    "order": ["@agentback/agent-mcp"], // optional; prefix of mount order, remainder appended
    "allowOverride": [], // DI keys a plugin may intentionally re-bind (see §3)
    "strict": true, // fail-closed: a broken plugin / key collision HALTS (default true)
  },
}
```

Two discovery sources, one gate. Both `scan` (declared deps) and `dirs`
(directory scan, the `loopback-boot`-style source) feed the same candidate set,
which the manifest then gates/orders.

Semantics:

- **No `plugins` config** → `scan: true`, `dirs: []`, mount every discovered
  plugin, `strict: true`.
- **`scan`** → discover from the app's declared npm dependencies.
- **`dirs`** → additionally scan each directory's immediate subdirectories for a
  marked `package.json` (local / dropped-in plugins that aren't npm deps). Same
  marker, same disk-read path as `scan`.
- **`enable` present** → allowlist; only those packages mount (still must be
  discovered + marked from either source). `enable` overrides "mount all".
- **`disable`** → removed from the final set after `enable`/scan/dirs.
- **`order`** → packages listed are mounted first in that order; the rest follow
  in discovery order. Cosmetic in practice (DI resolves lazily), retained as an
  escape hatch for any future component that does eager work at mount time.
- **`allowOverride`** → DI keys that a later plugin is permitted to re-bind
  without triggering a collision halt (see §3 collision detection).
- **`strict`** → fail-closed. A plugin that fails to import / is missing its named
  export / collides on a DI key HALTS startup. `strict: false` collects these
  into the report and continues. **Default `true`** — the unsafe default is the
  one people forget to flip, and a silently-skipped enforcement plugin is exactly
  the failure a governance substrate cannot have.

### Zod schema (shape)

```ts
const PluginsConfig = z
  .object({
    scan: z.boolean().default(true),
    dirs: z.array(z.string()).default([]),
    enable: z.array(z.string()).optional(),
    disable: z.array(z.string()).default([]),
    order: z.array(z.string()).default([]),
    allowOverride: z.array(z.string()).default([]),
    strict: z.boolean().default(true),
  })
  .default({});
```

## 3. Load sequence — `loadPlugins(app, options?)`

1. Read and Zod-validate the `plugins` config (from `@agentback/config`, or
   from `options.config` if passed explicitly).
2. **Discover** from two sources into one candidate set:
   - **`scan` (declared deps):** read the app's own `package.json` dependencies.
     For each dep, resolve its main entry with `import.meta.resolve(depName)`
     (the `"."` export, which always resolves), then **walk up the filesystem**
     from that URL to the nearest `package.json` and read it **off disk**
     (`fs.readFile` + `JSON.parse`). Check for the marker.
   - **`dirs` (directory scan):** for each configured dir, read its immediate
     subdirectories; in each, read `package.json` off disk and check the marker.
     Deterministic; no full `node_modules` walk. (`options.cwd` overrides the app
     root for tests.)

   > **ESM footgun (must not regress):** never reach `package.json` via module
   > resolution — `import('pkg/package.json')` throws
   > `ERR_PACKAGE_PATH_NOT_EXPORTED` because every `agent-*` package has a
   > restrictive `exports` map exposing only `"."`. Disk reads ignore `exports`
   > maps; that is why discovery reads `package.json` from the filesystem, not
   > through the loader.

3. **Gate**: apply `enable` / `disable` / `order` → final ordered candidate list.
4. **Mount** each candidate, tracking DI keys for collision detection:
   - Snapshot the app context's currently-bound keys.
   - `await import(entry)` (a bare specifier for `scan` packages; a
     `pathToFileURL(entry)` for `dirs` packages), read the named Component export.
     Missing export / not a Component → record error (halt if `strict`).
   - `app.component(Component)`.
   - Diff the context's bound keys against the snapshot; if the plugin introduced
     a key already owned by an earlier plugin (and not in `allowOverride`) →
     **collision**: record it (halt if `strict`). This closes the silent-override
     hole: `context.add()` only throws on _locked_ bindings, so without this diff
     a third-party plugin could quietly replace a first-party binding.
   - Emit a best-effort **audit event** `{name, version, source, component}`.
5. Return a `PluginLoadReport`.

### Report is the contract; the audit event is additive

The **synchronous `PluginLoadReport` is the testable source of truth** — tests
assert on it, never on the event. The **audit event** is a thin, best-effort
emission for live observers (console / control plane), and its transport is
deliberately deferred to match whatever the console already consumes (see Open
Questions). Decoupling them means the audit-transport decision never blocks the
test plan.

### Why audit at all (venture hook)

Plugin activation _is_ a governance event — "these capabilities were turned on in
this app." Recording it (in the report, and emitting the event) puts the
extensibility surface on rung 1 of the observe→approve→enforce ladder from day
one, rather than bolting audit on later. The `PluginLoadReport` is also what the
console / `context-explorer` would render.

### Report type

```ts
export interface PluginLoadReport {
  discovered: PluginInfo[]; // everything found by either source
  mounted: PluginInfo[]; // actually mounted, in mount order
  skipped: Array<PluginInfo & {reason: 'disabled' | 'not-enabled'}>;
  warnings: string[]; // non-fatal: enable/order names an undiscovered pkg, etc.
  errors: PluginLoadError[]; // import/export/collision failures (in strict mode, the
  // first one is also thrown — but still recorded here first)
}

export interface PluginLoadError {
  package: string;
  kind: 'import' | 'missing-export' | 'not-a-component' | 'key-collision';
  message: string;
  collidingKeys?: string[]; // populated when kind === 'key-collision'
}

export interface PluginInfo {
  name: string; // package name
  version: string;
  component: string; // export name
  source: 'deps' | 'dir'; // which discovery source found it
  path: string; // resolved package dir / entry path
}
```

### Error handling (fail-closed by default)

- **`strict` defaults to `true`.** The first error (un-importable, missing named
  export, export not a Component, or a DI key collision) is recorded in
  `report.errors` **and then thrown**, halting startup. Rationale: a governed
  bridge with a silently-skipped enforcement plugin is the exact failure mode a
  security substrate cannot have.
- **`strict: false`** collects all errors into `report.errors` and continues
  mounting the rest — for dev / lenient third-party hosting.
- **DI key collision** (a plugin re-binds a key an earlier plugin owns, not listed
  in `allowOverride`) is a first-class error kind, not a warning — same
  fail-closed treatment under `strict`.
- **`enable`/`order` names a package that was never discovered** → non-fatal
  `report.warnings` entry (manifest references a plugin that isn't installed or
  marked); never throws.
- **A configured `dirs` path is missing / unreadable** → non-fatal
  `report.warnings` entry; discovery continues with the other sources. A missing
  optional plugins directory must not take down startup (unlike a _broken_ plugin,
  which is a real fault). Covered by a unit test.
- The report is always fully populated before any throw, so the console / control
  plane can show exactly what happened even on a strict halt.

### Options

`options` overrides config-component values when passed (tests, programmatic use):

```ts
export interface LoadPluginsOptions {
  config?: PluginsConfigInput; // override the @agentback/config lookup
  cwd?: string; // app root for dep + dir discovery (default: process.cwd())
  strict?: boolean; // override config.strict (default: config value, which defaults true)
}
```

## 4. Package, wiring, and testing

- **New package `@agentback/plugin`** — a core-level capability (loads _any_
  `Component`, not agent-specific). Exports:
  - `loadPlugins(app, options?)`
  - the Zod manifest schema + inferred types
  - the marker types (`PluginPackageMarker`)
  - `PluginLoadReport` / `PluginInfo`
  - the discovery scanner (exported for the console/control plane to call
    discovery without mounting)
- **Wiring** (per `CLAUDE.md`): create `packages/plugin/{src,tsconfig.json,package.json}`,
  add to root `tsconfig.json` references in dependency order, `pnpm install` to
  link the workspace.
- **Tests** (run against built `dist/`, so build first). Target 100% of the load
  sequence's branches — see the coverage map below.
  - **Unit**:
    - manifest Zod parse: defaults (`scan:true`, `strict:true`, `dirs:[]`),
      `enable` allowlist, `disable`, `order`, `allowOverride`.
    - gate logic precedence: `enable` overrides scan-all; `disable` subtracts
      after enable; `order` prefixes; undiscovered `enable`/`order` name →
      `report.warnings`.
    - discovery `scan`: filter over a fixture dep map (marked vs unmarked).
    - **ESM resolution regression**: a fixture package whose `package.json` has a
      restrictive `exports` map exposing only `"."`; assert discovery reads its
      `package.json` off disk and does **not** throw
      `ERR_PACKAGE_PATH_NOT_EXPORTED`. (Guards Finding 1 forever.)
  - **Acceptance** (fixture plugin packages under `testlab` fixtures → an app →
    `loadPlugins`):
    - (a) the right components mounted; (b) their bindings resolve from the
      container; (c) `PluginLoadReport` correct (discovered/mounted/skipped/source).
    - (d) **`dirs` scan**: a local fixture dir (not an npm dep) is discovered and
      mounted via `pathToFileURL` import.
    - (e) **strict halt**: a deliberately broken plugin (missing named export)
      throws under `strict:true` and the thrown-before report still lists it in
      `errors`; under `strict:false` it lands in `errors` and the rest mount.
    - (f) **key collision** (CRITICAL regression test): two fixture plugins bind
      the same DI key → fatal under `strict:true`, recorded as
      `kind:'key-collision'` with `collidingKeys`; with that key in
      `allowOverride`, the second mounts and last-wins.
    - (g) audit: `report.mounted` has one entry per mounted plugin (the report is
      the assertion target, not the event).

## Migration / adoption

- Add the `AgentBack` marker stanza to the existing `agent-*` package
  `package.json` files so they are discoverable as first-party plugins.
- Examples (`hello-hybrid`, etc.) can optionally switch from explicit
  `app.component(...)` chains to `await loadPlugins(app)` — but the explicit API
  stays fully supported; the loader is additive, not a replacement.

## Open questions (non-blocking)

- **Audit event transport.** Reuse an existing emitter/lifecycle event, or emit a
  context event? Decide during implementation against whatever the console
  already consumes.
- **Workspace-link discovery.** In the pnpm monorepo, workspace deps resolve via
  symlinks; confirm the dependency-walk reads the linked `package.json` correctly
  (it should, since we read the app's declared deps and resolve each).
