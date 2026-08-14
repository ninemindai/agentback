# Plugin Composability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a mounted plugin set retractable (`report.uninstall()`), and derive mount order from a declared `provides`/`inject` graph instead of a hand-maintained `order:` list.

**Architecture:** `tryMount` already snapshots the app's bindings before and after `app.component()` and diffs them by binding _instance_ identity; today that diff is read once for collision detection and discarded. We retain it as the retraction footprint, compose per-mount teardowns LIFO with `composeTeardown()`, and add a pure `graph.ts` that topologically sorts the gated plugin set. Component keys are refcounted (not read from the diff) because `app.component()` early-returns for an already-mounted nested component, leaving the second plugin's diff empty.

**Tech Stack:** TypeScript 7 (`tsc` bin) / TS 6 module, ESM-only, Node 22.13+, pnpm 11 workspaces, Zod 4, vitest.

**Spec:** [docs/superpowers/specs/2026-08-14-plugin-composability-design.md](../specs/2026-08-14-plugin-composability-design.md) — ENG CLEARED, 11 findings folded.

## Global Constraints

- **Tests run against built `dist/`, not `src/`.** After editing any `.ts` you must `pnpm build` before `pnpm test` sees the change. Every "run the test" step below therefore builds first.
- **ESM:** every relative import carries a `.js` extension, even from a `.ts` file.
- **Copyright header** on every new file, exactly three lines:
  ```ts
  // Copyright NineMind, Inc. 2026. All Rights Reserved.
  // This file is licensed under the MIT License.
  // License text available at https://opensource.org/license/mit/
  ```
  Never reintroduce `Copyright IBM Corp.` headers.
- **Style** (`.prettierrc.json`): single quotes, **no bracket spacing** (`{foo}` not `{ foo }`), trailing commas everywhere, 80 columns, arrow parens avoided when possible.
- **Logging:** `loggers` from `@agentback/common` only. Never import the `debug` package directly.
- **No new dependencies.** Kahn's algorithm is hand-rolled (~25 lines); do not add `toposort`.
- **Additive only.** Every existing `@agentback/plugin` test must stay green. The one internal breaking change is `tryMount`'s return type, which is not exported.
- **Run `pnpm verify` before the final commit** — it mirrors CI (konsistent + build + typecheck:client + test + validate-templates + build:site).

---

### Task 1: Guarded revert helper in `@agentback/core`

The existing `unbindOwned` guards the _unbind_. The teardown also needs to _restore_ a displaced binding, and that write needs the **same** guard — if a third party rebound the key after us, skipping the unbind but still restoring clobbers them. One identity check must gate both halves.

**Files:**

- Modify: `packages/core/src/installed.ts:28-39`
- Test: `packages/core/src/__tests__/unit/installed.unit.ts` (create if absent)

**Interfaces:**

- Consumes: nothing (foundation task)
- Produces: `revertOwned(ctx, binding, displaced?): boolean` — returns `true` when the binding was still ours and was unbound (and `displaced` restored), `false` when a third party owns the key now and nothing was touched. `unbindOwned(ctx, binding): void` keeps its exact current signature and behavior.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/__tests__/unit/installed.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Context} from '@agentback/context';
import {revertOwned, unbindOwned} from '../../installed.js';

describe('revertOwned', () => {
  it('unbinds and restores the displaced binding when still ours', () => {
    const ctx = new Context();
    const prior = ctx.bind('k').to('prior');
    const ours = ctx.bind('k').to('ours');

    expect(revertOwned(ctx, ours, prior)).toBe(true);
    expect(ctx.getSync('k')).toBe('prior');
  });

  it('unbinds with no restore when there was no displaced binding', () => {
    const ctx = new Context();
    const ours = ctx.bind('k').to('ours');

    expect(revertOwned(ctx, ours)).toBe(true);
    expect(ctx.isBound('k')).toBe(false);
  });

  it('touches NOTHING when a third party rebound the key', () => {
    const ctx = new Context();
    const prior = ctx.bind('k').to('prior');
    const ours = ctx.bind('k').to('ours');
    ctx.bind('k').to('third-party');

    expect(revertOwned(ctx, ours, prior)).toBe(false);
    // The critical assertion: the restore must NOT fire either.
    expect(ctx.getSync('k')).toBe('third-party');
  });

  it('unbindOwned keeps its no-restore behavior', () => {
    const ctx = new Context();
    const ours = ctx.bind('k').to('ours');
    unbindOwned(ctx, ours);
    expect(ctx.isBound('k')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/core build && pnpm exec vitest run packages/core/dist/__tests__/unit/installed.unit.js
```

Expected: FAIL — `revertOwned` is not exported from `installed.js`.

- [ ] **Step 3: Write the implementation**

In `packages/core/src/installed.ts`, replace the `unbindOwned` function (lines 28-39) with:

```ts
/**
 * Retract a binding we own: unbind it, and restore whatever it displaced.
 *
 * ONE identity check gates BOTH halves, and that is the point. `Context.bind()`
 * REPLACES at a key, so an uninstall that blindly unbinds removes a binding the
 * user has since shadowed over ours — and an uninstall that blindly *restores*
 * is the same hazard mirrored, overwriting that shadow with a stale binding. If
 * the key is no longer ours, nothing happens at all.
 *
 * @returns `true` when the binding was still ours (unbound, and `displaced`
 * restored when given); `false` when the context was left untouched.
 */
export function revertOwned(
  ctx: {
    isBound(key: string): boolean;
    getBinding(key: string): unknown;
    unbind(key: string): boolean;
    add(binding: never): unknown;
  },
  binding: {key: string},
  displaced?: {key: string},
): boolean {
  if (!ctx.isBound(binding.key)) return false;
  if (ctx.getBinding(binding.key) !== binding) return false;
  ctx.unbind(binding.key);
  if (displaced !== undefined) ctx.add(displaced as never);
  return true;
}

/**
 * Unbind `binding`'s key only if that exact binding is still the one bound —
 * the identity-guarded inverse of a bind. Ownership, not key possession, is
 * what an inverse may retract. Thin wrapper over {@link revertOwned} with no
 * displaced binding to restore.
 */
export function unbindOwned(
  ctx: {
    isBound(key: string): boolean;
    getBinding(key: string): unknown;
    unbind(key: string): boolean;
    add(binding: never): unknown;
  },
  binding: {key: string},
): void {
  revertOwned(ctx, binding);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F @agentback/core build && pnpm exec vitest run packages/core/dist/__tests__/unit/installed.unit.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the 11 existing `unbindOwned` call sites still compile and pass**

```bash
pnpm build && pnpm test
```

Expected: PASS. `unbindOwned`'s signature is unchanged, so this is a no-op refactor for every existing caller.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/installed.ts packages/core/src/__tests__/unit/installed.unit.ts
git commit -m "feat(core): revertOwned — one identity check gates unbind and restore

unbindOwned guards the unbind. A teardown that also restores a displaced
binding needs the same guard on that write: if a third party rebound the key,
skipping the unbind but restoring anyway clobbers them, which is the exact bug
the guard exists to prevent. unbindOwned now delegates, unchanged."
```

---

### Task 2: Read `provides` / `inject` from the package marker

**Files:**

- Modify: `packages/plugin/src/types.ts:13-32`
- Modify: `packages/plugin/src/discovery.ts:49-76`
- Test: `packages/plugin/src/__tests__/unit/discovery.unit.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `PluginInfo.provides: string[]` and `PluginInfo.inject: string[]` — always arrays, normalized to `[]` when the marker omits them or supplies a malformed value. `PluginPackageMarker.provides?: string[]`, `.inject?: string[]`.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugin/src/__tests__/unit/discovery.unit.ts`:

```ts
describe('readMarker — provides/inject', () => {
  it('normalizes a missing provides/inject to empty arrays', () => {
    const info = readMarker(resolve(fixtures, 'good-plugin'), 'dir');
    expect(info?.provides).toEqual([]);
    expect(info?.inject).toEqual([]);
  });

  it('reads declared provides and inject', () => {
    const info = readMarker(resolve(fixtures, 'graph-provider'), 'dir');
    expect(info?.provides).toEqual(['services.Shared']);
    expect(info?.inject).toEqual([]);
  });

  it('ignores a malformed provides without failing discovery', () => {
    const info = readMarker(resolve(fixtures, 'graph-malformed'), 'dir');
    expect(info).not.toBeNull();
    expect(info?.provides).toEqual([]);
  });
});
```

Create fixture `packages/plugin/fixtures/graph-provider/package.json`:

```json
{
  "name": "@fixture/graph-provider",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {
    "plugin": true,
    "component": "ProviderComponent",
    "provides": ["services.Shared"]
  }
}
```

Create `packages/plugin/fixtures/graph-provider/index.js`:

```js
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';

export class ProviderComponent {
  constructor() {
    this.bindings = [Binding.bind('services.Shared').to('from-provider')];
  }
}
```

Create fixture `packages/plugin/fixtures/graph-malformed/package.json`:

```json
{
  "name": "@fixture/graph-malformed",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {
    "plugin": true,
    "component": "MalformedComponent",
    "provides": "services.NotAnArray"
  }
}
```

Create `packages/plugin/fixtures/graph-malformed/index.js`:

```js
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export class MalformedComponent {
  constructor() {
    this.services = [];
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/discovery.unit.js
```

Expected: FAIL — `info.provides` is `undefined`.

- [ ] **Step 3: Extend the types**

In `packages/plugin/src/types.ts`, replace the `PluginPackageMarker` interface and add two fields to `PluginInfo`:

```ts
export interface PluginPackageMarker {
  plugin: true;
  /** Named export of the package's main module that is a Component. */
  component: string;
  /** Binding keys this plugin contributes. Advisory: governs ordering and
   * pre-import duplicate detection, never resolution. */
  provides?: string[];
  /** Binding keys this plugin needs bound before it mounts. Advisory. */
  inject?: string[];
}
```

and inside `PluginInfo`, after `importSpecifier`:

```ts
  /** Normalized from the marker; `[]` when absent or malformed. */
  provides: string[];
  /** Normalized from the marker; `[]` when absent or malformed. */
  inject: string[];
```

- [ ] **Step 4: Read them in `discovery.ts`**

In `packages/plugin/src/discovery.ts`, add this helper immediately above `readMarker`:

```ts
/**
 * A marker field is caller-authored JSON, so a malformed value must not crash
 * discovery — the surrounding `readMarker` already skips an invalid marker
 * rather than throwing. Non-arrays and non-string entries are dropped.
 */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v !== '');
}
```

and in `readMarker`'s returned object, after `importSpecifier`:

```ts
    provides: stringArray(marker.provides),
    inject: stringArray(marker.inject),
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/discovery.unit.js
```

Expected: PASS.

- [ ] **Step 6: Fix the `PluginInfo` literal in `gate.unit.ts`**

`packages/plugin/src/__tests__/unit/gate.unit.ts:10-19` builds a `PluginInfo` literal that now misses two required fields. Add them to the helper:

```ts
function info(name: string): PluginInfo {
  return {
    name,
    version: '1.0.0',
    component: 'C',
    source: 'deps',
    path: `/x/${name}`,
    importSpecifier: name,
    provides: [],
    inject: [],
  };
}
```

- [ ] **Step 7: Commit**

```bash
pnpm build && pnpm test
git add packages/plugin/src/types.ts packages/plugin/src/discovery.ts \
  packages/plugin/src/__tests__/unit/discovery.unit.ts \
  packages/plugin/src/__tests__/unit/gate.unit.ts packages/plugin/fixtures
git commit -m "feat(plugin): read provides/inject from the agentback marker

Discovery already reads the stanza off disk without importing the package, so
a declared dependency graph costs nothing at runtime. Malformed values are
dropped rather than fatal, matching how an invalid marker is already skipped."
```

---

### Task 3: `graph.ts` — the topological sort

Pure data in, data out. No `Application`, no imports, no I/O — which is why it is its own file and its own test.

**Files:**

- Create: `packages/plugin/src/graph.ts`
- Test: `packages/plugin/src/__tests__/unit/graph.unit.ts`

**Interfaces:**

- Consumes: `PluginInfo` (Task 2), `PluginLoadError` from `./types.js`
- Produces: `sortByGraph(input: SortInput): GraphResult` where
  `SortInput = {gated: PluginInfo[]; skipped: PluginInfo[]; appOwnedKeys: ReadonlySet<string>; order: string[]; allowOverride: ReadonlySet<string>}`
  and `GraphResult = {ordered: PluginInfo[]; errors: PluginLoadError[]; warnings: string[]}`.

- [ ] **Step 1: Add the three error kinds**

In `packages/plugin/src/types.ts`, extend `PluginLoadErrorKind`:

```ts
export type PluginLoadErrorKind =
  | 'import'
  | 'missing-export'
  | 'not-a-component'
  | 'key-collision'
  | 'unsatisfied-inject'
  | 'dependency-cycle'
  | 'duplicate-provides';
```

- [ ] **Step 2: Write the failing test**

Create `packages/plugin/src/__tests__/unit/graph.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {sortByGraph} from '../../graph.js';
import type {PluginInfo} from '../../types.js';

function info(
  name: string,
  provides: string[] = [],
  inject: string[] = [],
): PluginInfo {
  return {
    name,
    version: '1.0.0',
    component: 'C',
    source: 'deps',
    path: `/x/${name}`,
    importSpecifier: name,
    provides,
    inject,
  };
}

const EMPTY = {
  skipped: [],
  appOwnedKeys: new Set<string>(),
  order: [],
  allowOverride: new Set<string>(),
};

describe('sortByGraph', () => {
  it('derives order from inject -> provides, against discovery order', () => {
    const consumer = info('consumer', [], ['services.Db']);
    const provider = info('provider', ['services.Db']);
    // Discovery order is deliberately WRONG (consumer first).
    const r = sortByGraph({...EMPTY, gated: [consumer, provider]});
    expect(r.errors).toEqual([]);
    expect(r.ordered.map(p => p.name)).toEqual(['provider', 'consumer']);
  });

  it('an app-bound key satisfies an inject and adds NO edge', () => {
    const consumer = info('consumer', [], ['services.Db']);
    const other = info('other');
    const r = sortByGraph({
      ...EMPTY,
      gated: [consumer, other],
      appOwnedKeys: new Set(['services.Db']),
    });
    expect(r.errors).toEqual([]);
    // No edge means discovery order is preserved.
    expect(r.ordered.map(p => p.name)).toEqual(['consumer', 'other']);
  });

  it('with zero declarations, order: fully governs (back-compat)', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a'), info('b'), info('c')],
      order: ['c', 'b'],
    });
    expect(r.ordered.map(p => p.name)).toEqual(['c', 'b', 'a']);
  });

  it('order: breaks ties only among simultaneously-ready plugins', () => {
    const provider = info('provider', ['services.Db']);
    const consumer = info('consumer', [], ['services.Db']);
    const loner = info('loner');
    // order: asks for consumer first, but the edge outranks it.
    const r = sortByGraph({
      ...EMPTY,
      gated: [provider, consumer, loner],
      order: ['consumer', 'loner'],
    });
    expect(r.ordered.map(p => p.name)).toEqual([
      'loner',
      'provider',
      'consumer',
    ]);
  });

  it('reports an unsatisfiable inject', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', [], ['services.Gone'])],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe('unsatisfied-inject');
    expect(r.errors[0].package).toBe('a');
    expect(r.errors[0].message).toContain('services.Gone');
  });

  it('names the gate when the provider was discovered but skipped', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', [], ['services.Db'])],
      skipped: [info('provider', ['services.Db'])],
    });
    expect(r.errors[0].kind).toBe('unsatisfied-inject');
    expect(r.errors[0].message).toContain('provider');
  });

  it('reports a cycle naming BOTH plugins', () => {
    const a = info('a', ['services.A'], ['services.B']);
    const b = info('b', ['services.B'], ['services.A']);
    const r = sortByGraph({...EMPTY, gated: [a, b]});
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe('dependency-cycle');
    expect(r.errors[0].message).toContain('a');
    expect(r.errors[0].message).toContain('b');
    expect(r.ordered).toEqual([]);
  });

  it('reports duplicate provides before any import', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', ['services.X']), info('b', ['services.X'])],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe('duplicate-provides');
    expect(r.errors[0].collidingKeys).toEqual(['services.X']);
  });

  it('allows duplicate provides when allowOverride lists the key', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', ['services.X']), info('b', ['services.X'])],
      allowOverride: new Set(['services.X']),
    });
    expect(r.errors).toEqual([]);
    expect(r.ordered).toHaveLength(2);
  });

  it('an under-declared inject still mounts (advisory, not enforced)', () => {
    // 'consumer' really needs services.Db but never declared it.
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('consumer'), info('provider', ['services.Db'])],
    });
    expect(r.errors).toEqual([]);
    expect(r.ordered).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/graph.unit.js
```

Expected: FAIL — cannot resolve `../../graph.js`.

- [ ] **Step 4: Write the implementation**

Create `packages/plugin/src/graph.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {PluginInfo, PluginLoadError} from './types.js';

export interface SortInput {
  /** Plugins that survived the gate, in discovery order. */
  gated: PluginInfo[];
  /** Plugins the gate dropped — used only to explain an unsatisfied inject. */
  skipped: PluginInfo[];
  /** Keys already bound on the app before `loadPlugins` ran. */
  appOwnedKeys: ReadonlySet<string>;
  /** Manifest `order:` — the tiebreaker among simultaneously-ready plugins. */
  order: string[];
  /** Keys a plugin may intentionally re-bind. */
  allowOverride: ReadonlySet<string>;
}

export interface GraphResult {
  ordered: PluginInfo[];
  errors: PluginLoadError[];
  warnings: string[];
}

/**
 * Order the gated set by `inject -> provides`, and reject a graph that cannot
 * be satisfied — all BEFORE any plugin is imported, which is the whole point:
 * the snapshot-diff collision check can only fire after `app.component()` has
 * already run its side effects.
 *
 *   gated ──► providers map ──► duplicate check ──► edges ──► Kahn ──► ordered
 *                    │                │                │         │
 *                    │                │                │         └─ leftover = cycle
 *                    │                │                └─ missing = unsatisfied
 *                    │                └─ two providers, no allowOverride
 *                    └─ appOwnedKeys satisfy WITHOUT an edge
 *
 * Determinism: Kahn's algorithm, and among nodes that become ready at the same
 * time the `order:` index wins, then discovery index. Never Map iteration.
 */
export function sortByGraph(input: SortInput): GraphResult {
  const {gated, skipped, appOwnedKeys, order, allowOverride} = input;
  const errors: PluginLoadError[] = [];
  const warnings: string[] = [];

  const discoveryIndex = new Map(gated.map((p, i) => [p.name, i]));
  const orderIndex = new Map(order.map((n, i) => [n, i]));
  const rank = (name: string): [number, number] => [
    orderIndex.get(name) ?? Number.MAX_SAFE_INTEGER,
    discoveryIndex.get(name) ?? Number.MAX_SAFE_INTEGER,
  ];

  // 1. Who provides what. A key claimed twice is a collision unless the
  //    manifest says the override is intentional.
  const providers = new Map<string, string>();
  const duplicates = new Map<string, string[]>();
  for (const p of gated) {
    for (const key of p.provides) {
      const prior = providers.get(key);
      if (prior !== undefined && !allowOverride.has(key)) {
        const list = duplicates.get(key) ?? [prior];
        list.push(p.name);
        duplicates.set(key, list);
        continue;
      }
      providers.set(key, p.name);
    }
  }
  for (const [key, names] of duplicates) {
    errors.push({
      package: names[names.length - 1],
      kind: 'duplicate-provides',
      message:
        `declares provides "${key}", already declared by ` +
        `${names.slice(0, -1).join(', ')}. List it in plugins.allowOverride ` +
        `if the override is intentional.`,
      collidingKeys: [key],
    });
  }
  if (errors.length) return {ordered: [], errors, warnings};

  // 2. Edges. A key the APP already bound satisfies an inject with no edge —
  //    not every dependency comes from a plugin.
  const skippedProviders = new Map<string, string>();
  for (const p of skipped) {
    for (const key of p.provides) skippedProviders.set(key, p.name);
  }

  const dependsOn = new Map<string, Set<string>>(
    gated.map(p => [p.name, new Set<string>()]),
  );
  for (const p of gated) {
    for (const key of p.inject) {
      if (appOwnedKeys.has(key)) continue;
      const provider = providers.get(key);
      if (provider === undefined) {
        const gatedOut = skippedProviders.get(key);
        errors.push({
          package: p.name,
          kind: 'unsatisfied-inject',
          message: gatedOut
            ? `injects "${key}", provided by ${gatedOut}, which the manifest ` +
              `gate excluded (enable/disable).`
            : `injects "${key}", which no mounted plugin provides and the ` +
              `application has not bound.`,
        });
        continue;
      }
      if (provider !== p.name) dependsOn.get(p.name)!.add(provider);
    }
  }
  if (errors.length) return {ordered: [], errors, warnings};

  // 3. Kahn, with a total deterministic tiebreak.
  const remaining = new Map(gated.map(p => [p.name, p]));
  const ordered: PluginInfo[] = [];
  while (remaining.size) {
    const ready: string[] = [];
    for (const name of remaining.keys()) {
      const deps = dependsOn.get(name)!;
      let blocked = false;
      for (const d of deps) {
        if (remaining.has(d)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) ready.push(name);
    }
    if (!ready.length) break; // cycle
    ready.sort((a, b) => {
      const [ao, ad] = rank(a);
      const [bo, bd] = rank(b);
      return ao !== bo ? ao - bo : ad - bd;
    });
    const next = ready[0];
    ordered.push(remaining.get(next)!);
    remaining.delete(next);
  }

  if (remaining.size) {
    const names = [...remaining.keys()].sort();
    errors.push({
      package: names[0],
      kind: 'dependency-cycle',
      message:
        `is in a provides/inject cycle with: ${names.join(', ')}. ` +
        `Factor the shared dependency into its own plugin.`,
    });
    return {ordered: [], errors, warnings};
  }

  return {ordered, errors, warnings};
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/graph.unit.js
```

Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin/src/graph.ts packages/plugin/src/types.ts \
  packages/plugin/src/__tests__/unit/graph.unit.ts
git commit -m "feat(plugin): sortByGraph — derive mount order from provides/inject

Kahn over the declared edges, with order: demoted to a tiebreaker among
simultaneously-ready plugins. With zero declarations every node is ready at
once, so order: still fully governs — existing apps mount unchanged, and there
is a test pinning that. Duplicate provides honors allowOverride, because two
plugins re-binding one key is a supported case today."
```

---

### Task 4: Wire the graph into `loadPlugins`

**Files:**

- Modify: `packages/plugin/src/load-plugins.ts:37-48`
- Test: `packages/plugin/src/__tests__/acceptance/load-plugins.acceptance.ts`

**Interfaces:**

- Consumes: `sortByGraph` (Task 3), `appOwnedContext` (`mount.ts:29`)
- Produces: nothing new externally; `report.errors` may now carry the three graph kinds, and mount order follows the graph.

- [ ] **Step 1: Write the failing test**

Append to `packages/plugin/src/__tests__/acceptance/load-plugins.acceptance.ts`:

```ts
describe('loadPlugins — declared graph', () => {
  it('mounts a provider before its consumer regardless of discovery order', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: fixtures,
      config: {
        scan: false,
        dirs: ['.'],
        enable: ['@fixture/graph-consumer', '@fixture/graph-provider'],
      },
    });
    expect(report.errors).toEqual([]);
    expect(report.mounted.map(p => p.name)).toEqual([
      '@fixture/graph-provider',
      '@fixture/graph-consumer',
    ]);
  });

  it('fails closed on an unsatisfiable inject, with NOTHING mounted', async () => {
    const app = new Application();
    await expect(
      loadPlugins(app, {
        cwd: fixtures,
        config: {scan: false, dirs: ['.'], enable: ['@fixture/graph-consumer']},
      }),
    ).rejects.toThrow(/unsatisfied-inject/);
    // The graph runs before any import, so no plugin was mounted.
    expect(app.isBound('components.ConsumerComponent')).toBe(false);
  });
});
```

Create fixture `packages/plugin/fixtures/graph-consumer/package.json`:

```json
{
  "name": "@fixture/graph-consumer",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {
    "plugin": true,
    "component": "ConsumerComponent",
    "inject": ["services.Shared"]
  }
}
```

Create `packages/plugin/fixtures/graph-consumer/index.js`:

```js
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export class ConsumerComponent {
  constructor() {
    this.services = [];
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/load-plugins.acceptance.js
```

Expected: FAIL — mount order follows discovery, not the graph.

- [ ] **Step 3: Wire it in**

In `packages/plugin/src/load-plugins.ts`, add the import:

```ts
import {sortByGraph} from './graph.js';
```

Then replace lines 37-50 (from `const warnings` through `const ctx = appOwnedContext(...)`) with:

```ts
const warnings: string[] = [];
const discovered = await discover(config, cwd, warnings);
const gate = applyGate(discovered, config);
warnings.push(...gate.warnings);

const ctx = appOwnedContext(app, config.allowOverride);
const graph = sortByGraph({
  gated: gate.ordered,
  skipped: gate.skipped,
  appOwnedKeys: new Set(ctx.owners.keys()),
  order: config.order,
  allowOverride: ctx.allowOverride,
});
warnings.push(...graph.warnings);

const report: PluginLoadReport = {
  discovered,
  mounted: [],
  skipped: gate.skipped,
  warnings,
  errors: [],
};
```

and change the mount loop's iterable from `gate.ordered` to `graph.ordered`, adding the graph-error gate immediately before it:

```ts
  for (const err of graph.errors) fail(err);

  for (const info of graph.ordered) {
```

`fail` throws on the first error under `strict`, so a bad graph halts before the loop; under `strict: false` the errors are collected and the satisfiable remainder still mounts.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/load-plugins.acceptance.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm build && pnpm test
git add packages/plugin/src/load-plugins.ts \
  packages/plugin/src/__tests__/acceptance/load-plugins.acceptance.ts \
  packages/plugin/fixtures/graph-consumer
git commit -m "feat(plugin): mount in graph-derived order, reject a bad graph pre-import

appOwnedContext already snapshots every key bound before loadPlugins, so it
doubles as the satisfied-by-the-app set. A graph error now halts with zero
mounts performed, where a collision could only ever be caught after
app.component() had run its side effects."
```

---

### Task 5: Capture the footprint and build the teardown

**Files:**

- Modify: `packages/plugin/src/mount.ts:44-94`
- Test: `packages/plugin/src/__tests__/unit/mount.unit.ts` (create)

**Interfaces:**

- Consumes: `revertOwned` (Task 1), `composeTeardown` from `@agentback/common`
- Produces:
  - `MountOutcome = {ok: true; footprint: MountFootprint} | {ok: false; error: PluginLoadError}` — `tryMount`'s new return type (internal, not exported from the package barrel).
  - `MountFootprint = {touched: Array<{binding: Binding; displaced?: Binding}>; componentKeys: string[]}`
  - `buildTeardown(app, footprints, refs): () => Promise<void>` — the SINGLE teardown builder, used by both `loadPlugin` and `loadPlugins`.

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/src/__tests__/unit/mount.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {Binding} from '@agentback/context';
import {appOwnedContext, buildTeardown, tryMount} from '../../mount.js';
import type {PluginInfo} from '../../types.js';

function fixtureInfo(name: string, component: string): PluginInfo {
  return {
    name,
    version: '1.0.0',
    component,
    source: 'dir',
    path: `/x/${name}`,
    importSpecifier: new URL(
      `../../../fixtures/${name}/index.js`,
      import.meta.url,
    ).href,
    provides: [],
    inject: [],
  };
}

describe('buildTeardown', () => {
  it('restores a displaced binding by INSTANCE identity', async () => {
    const app = new Application();
    const original = app.bind('services.Shared').to('app-owned');
    const ctx = appOwnedContext(app, ['services.Shared']);
    const refs = new Map<string, number>();

    const outcome = await tryMount(
      app,
      fixtureInfo('collide-a', 'CollideAComponent'),
      ctx,
      refs,
    );
    expect(outcome.ok).toBe(true);
    expect(app.getSync('services.Shared')).toBe('a');

    const teardown = buildTeardown(app, [outcome], refs);
    await teardown();

    expect(app.getBinding('services.Shared')).toBe(original);
    expect(app.getSync('services.Shared')).toBe('app-owned');
  });

  it('touches NOTHING when a third party rebound a touched key', async () => {
    const app = new Application();
    app.bind('services.Shared').to('app-owned');
    const ctx = appOwnedContext(app, ['services.Shared']);
    const refs = new Map<string, number>();

    const outcome = await tryMount(
      app,
      fixtureInfo('collide-a', 'CollideAComponent'),
      ctx,
      refs,
    );
    const teardown = buildTeardown(app, [outcome], refs);

    // Somebody else shadows the key AFTER the plugin mounted.
    const third = app.bind('services.Shared').to('third-party');
    await teardown();

    // Neither the unbind nor the restore may fire.
    expect(app.getBinding('services.Shared')).toBe(third);
    expect(app.getSync('services.Shared')).toBe('third-party');
  });

  it('is idempotent — a second run is a no-op', async () => {
    const app = new Application();
    const ctx = appOwnedContext(app);
    const refs = new Map<string, number>();
    const outcome = await tryMount(
      app,
      fixtureInfo('good-plugin', 'GoodComponent'),
      ctx,
      refs,
    );
    const teardown = buildTeardown(app, [outcome], refs);

    await teardown();
    expect(app.isBound('components.GoodComponent')).toBe(false);
    await expect(teardown()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/mount.unit.js
```

Expected: FAIL — `buildTeardown` is not exported and `tryMount` takes 3 args.

- [ ] **Step 3: Rewrite `mount.ts`**

Replace `packages/plugin/src/mount.ts` in full:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Binding} from '@agentback/context';
import {composeTeardown} from '@agentback/common';
import type {Application, Component} from '@agentback/core';
import {CoreBindings, revertOwned} from '@agentback/core';
import type {PluginInfo, PluginLoadError} from './types.js';

/**
 * Snapshot key -> Binding INSTANCE for every binding in the context. Instance
 * identity (not just key presence) is what lets us detect an *override*:
 * `context.add()` does `registry.set(key, binding)`, so re-binding an existing
 * key keeps the key string but swaps the Binding object. It is also what makes
 * the diff a usable retraction footprint — `before.get(key)` IS the binding
 * this mount displaced.
 */
export function boundBindings(app: Application): Map<string, Binding> {
  return new Map(app.find().map(b => [b.key, b]));
}

/**
 * Per-load ledger threaded across mounts. `owners` maps each bound DI key to
 * the name of the plugin (or `<app>`) that owns it; `allowOverride` lists keys
 * a later mount may intentionally re-bind without it counting as a collision.
 */
export interface MountContext {
  owners: Map<string, string>;
  allowOverride: Set<string>;
}

/** One mount's retraction footprint. */
export interface MountFootprint {
  /** Bindings this mount added or replaced, with what each displaced. */
  touched: Array<{binding: Binding; displaced?: Binding}>;
  /**
   * Every `components.*` key this plugin REFERENCES — including nested
   * components it did not bind because `app.component()` early-returned.
   * Refcounted, never unbound on the strength of this footprint alone.
   */
  componentKeys: string[];
}

export type MountOutcome =
  {ok: true; footprint: MountFootprint} | {ok: false; error: PluginLoadError};

/** Initialize a `MountContext` treating every already-bound key as app-owned. */
export function appOwnedContext(
  app: Application,
  allowOverride: Iterable<string> = [],
): MountContext {
  const owners = new Map<string, string>();
  for (const key of boundBindings(app).keys()) owners.set(key, '<app>');
  return {owners, allowOverride: new Set(allowOverride)};
}

/**
 * Every `components.*` key a mounted component tree references.
 *
 * This CANNOT come from the binding diff. `app.component()` early-returns when
 * the key is already bound to the same constructor, so when a second plugin
 * lists a nested component the first one already mounted, the second's diff is
 * empty for it — and retracting the first would break the second. Walk the
 * resolved instance's `.components` tree instead, which reports the reference
 * whether or not this mount created the binding.
 */
function referencedComponentKeys(app: Application, rootKey: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
    if (!app.isBound(key)) return;
    const instance = app.getSync<Component>(key);
    for (const child of instance.components ?? []) {
      visit(`${CoreBindings.COMPONENTS}.${child.name}`);
    }
  };
  visit(rootKey);
  return keys;
}

/**
 * Import a resolved plugin, mount its `Component` via `app.component()`, and
 * detect DI-key collisions against `ctx`. Returns a `PluginLoadError` (without
 * throwing) on any failure so callers choose their own fail policy; mutates
 * `ctx.owners` for every key this mount touches and bumps `refs` for every
 * component key it references.
 *
 * A REJECTED mount leaves nothing behind: the teardown is built from the diff
 * BEFORE the collision check, and run on the error path.
 */
export async function tryMount(
  app: Application,
  info: PluginInfo,
  ctx: MountContext,
  refs: Map<string, number>,
): Promise<MountOutcome> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(info.importSpecifier)) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {package: info.name, kind: 'import', message: String(err)},
    };
  }

  const exported = mod[info.component];
  if (typeof exported !== 'function') {
    return {
      ok: false,
      error: {
        package: info.name,
        kind: 'missing-export',
        message: `named export "${info.component}" is missing or not a class`,
      },
    };
  }

  const before = boundBindings(app);
  let rootKey: string;
  try {
    rootKey = app.component(
      exported as new (...args: unknown[]) => Component,
    ).key;
  } catch (err) {
    return {
      ok: false,
      error: {package: info.name, kind: 'import', message: String(err)},
    };
  }
  const after = boundBindings(app);

  const touched: MountFootprint['touched'] = [];
  const collisions: string[] = [];
  for (const [key, binding] of after) {
    const priorBinding = before.get(key);
    if (priorBinding === binding) continue;
    touched.push({binding, displaced: priorBinding});
    const prior = ctx.owners.get(key);
    if (prior && prior !== info.name && !ctx.allowOverride.has(key)) {
      collisions.push(key);
    }
    ctx.owners.set(key, info.name);
  }
  const componentKeys = referencedComponentKeys(app, rootKey);
  const footprint: MountFootprint = {touched, componentKeys};

  if (collisions.length) {
    // Roll the mount back: app.component() already ran its side effects, and a
    // rejected plugin that stays mounted is invisible in report.mounted, so no
    // later teardown would ever cover it.
    await buildTeardown(app, [{ok: true, footprint}], new Map())();
    for (const key of collisions) ctx.owners.delete(key);
    return {
      ok: false,
      error: {
        package: info.name,
        kind: 'key-collision',
        message: `re-binds key(s) owned by another plugin: ${collisions.join(', ')}`,
        collidingKeys: collisions,
      },
    };
  }

  for (const key of componentKeys) refs.set(key, (refs.get(key) ?? 0) + 1);
  return {ok: true, footprint};
}

/**
 * The ONE teardown builder — both `loadPlugin` and `loadPlugins` go through it,
 * so the guarded-restore rule lives in exactly one place.
 *
 * Order per mount, in reverse mount order:
 *   1. stop retracting lifecycle observers (Task 8 wires this in)
 *   2. revertOwned() each touched key — one identity check gates the unbind
 *      AND the restore
 *   3. a components.* key is unbound only when its refcount reaches 0
 */
export function buildTeardown(
  app: Application,
  outcomes: MountOutcome[],
  refs: Map<string, number>,
): () => Promise<void> {
  const teardown = composeTeardown();
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const {touched, componentKeys} = outcome.footprint;
    teardown.push(() => {
      for (const key of componentKeys) {
        const next = (refs.get(key) ?? 1) - 1;
        refs.set(key, next);
      }
      // Reverse within the mount too: last binding added is first removed.
      for (let i = touched.length - 1; i >= 0; i--) {
        const {binding, displaced} = touched[i];
        const isComponentKey = componentKeys.includes(binding.key);
        if (isComponentKey && (refs.get(binding.key) ?? 0) > 0) continue;
        revertOwned(app, binding, displaced);
      }
    });
  }
  return () => teardown.run();
}
```

- [ ] **Step 4: Export `revertOwned` from the core barrel**

Confirm `packages/core/src/index.ts` re-exports `./installed.js`. If it exports named symbols explicitly, add `revertOwned` alongside `unbindOwned`.

- [ ] **Step 5: Update the two `tryMount` call sites to the new signature**

In `packages/plugin/src/load-plugins.ts`, the loop becomes:

```ts
const refs = new Map<string, number>();
const outcomes: MountOutcome[] = [];
for (const info of graph.ordered) {
  const outcome = await tryMount(app, info, ctx, refs);
  if (!outcome.ok) {
    fail(outcome.error);
    continue;
  }
  outcomes.push(outcome);
  report.mounted.push(info);
}
```

Import `MountOutcome` and `buildTeardown` from `./mount.js`. Do the same shape in `load-plugin.ts` (single element).

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm build && pnpm exec vitest run packages/plugin/dist/__tests__
```

Expected: PASS, including the three new `mount.unit` tests and every pre-existing plugin test.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin/src/mount.ts packages/plugin/src/load-plugins.ts \
  packages/plugin/src/load-plugin.ts packages/core/src/index.ts \
  packages/plugin/src/__tests__/unit/mount.unit.ts
git commit -m "feat(plugin): retain the mount footprint and build its inverse

The before/after binding diff was already computed for collision detection and
discarded; it is the footprint. Component keys come from walking the resolved
instance .components tree instead, because app.component() early-returns for an
already-mounted nested component and leaves the second plugin's diff empty.
A colliding mount now rolls back instead of staying mounted and unreported."
```

---

### Task 6: Stop lifecycle observers through the registry

**Files:**

- Modify: `packages/plugin/src/mount.ts` (`buildTeardown`)
- Test: `packages/plugin/src/__tests__/acceptance/unmount.acceptance.ts` (create)

**Interfaces:**

- Consumes: `MountFootprint` (Task 5), `CoreTags.LIFE_CYCLE_OBSERVER`
- Produces: no new exports; `buildTeardown`'s returned function is now async-effectful (it already returns a promise).

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/src/__tests__/acceptance/unmount.acceptance.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {loadPlugin} from '../../load-plugin.js';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../..', 'fixtures');

describe('uninstall — lifecycle observers', () => {
  it('does NOT stop an observer when the app was never started', async () => {
    const app = new Application();
    const installed = await loadPlugin(
      app,
      resolve(fixtures, 'observer-plugin'),
    );
    await installed.uninstall();

    const stops = app.getSync<string[]>('test.observerStops');
    expect(stops).toEqual([]);
  });

  it('stops the observer when the app IS started', async () => {
    const app = new Application();
    const installed = await loadPlugin(
      app,
      resolve(fixtures, 'observer-plugin'),
    );
    await app.start();
    await installed.uninstall();

    const stops = app.getSync<string[]>('test.observerStops');
    expect(stops).toEqual(['observer-plugin']);
    await app.stop();
  });

  it('app.stop() then uninstall() does not double-stop', async () => {
    const app = new Application();
    const installed = await loadPlugin(
      app,
      resolve(fixtures, 'observer-plugin'),
    );
    await app.start();
    await app.stop();
    await installed.uninstall();

    const stops = app.getSync<string[]>('test.observerStops');
    expect(stops).toEqual(['observer-plugin']);
  });
});
```

Create `packages/plugin/fixtures/observer-plugin/package.json`:

```json
{
  "name": "@fixture/observer-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {
    "plugin": true,
    "component": "ObserverComponent"
  }
}
```

Create `packages/plugin/fixtures/observer-plugin/index.js`:

```js
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';

const stops = [];

export class RecordingObserver {
  async stop() {
    stops.push('observer-plugin');
  }
}

export class ObserverComponent {
  constructor() {
    this.lifeCycleObservers = [RecordingObserver];
    this.bindings = [Binding.bind('test.observerStops').to(stops)];
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/unmount.acceptance.js
```

Expected: FAIL on the second case — the observer is never stopped.

- [ ] **Step 3: Add the observer step to `buildTeardown`**

In `packages/plugin/src/mount.ts`, add the import:

```ts
import {CoreTags} from '@agentback/core';
import type {LifeCycleObserver} from '@agentback/core';
```

and make the pushed disposer async, running the observer step first:

```ts
    teardown.push(async () => {
      // Only when the app is live. Application.stop() itself no-ops outside
      // started|initialized, and a plugin author's stop() is not guaranteed
      // idempotent, so gating on state is what prevents a double-stop after
      // app.stop() — not an assumption about someone else's discipline.
      const state = app.state;
      if (state === 'started' || state === 'initialized') {
        for (const {binding} of touched) {
          if (!binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER]) continue;
          if (!app.isBound(binding.key)) continue;
          if (app.getBinding(binding.key) !== binding) continue;
          const observer = await app.get<LifeCycleObserver>(binding.key);
          await observer.stop?.();
        }
      }
      for (const key of componentKeys) {
        // …unchanged from Task 5…
```

First add the subset entry point. `LifeCycleObserverRegistry` has no public
"stop these" method, and hand-rolling a second notify path here would lose
exactly what going through the registry buys. Append to
`packages/core/src/lifecycle-registry.ts` after `stop()` (line 270):

```ts
  /**
   * Notify a SUBSET of observers of `stop`, by binding key.
   *
   * Reuses the full `stop()` path — group order (reversed), `disabledGroups`,
   * the `parallel` setting, and `invokeMethod` argument injection — so a
   * partial retraction behaves exactly like a shutdown restricted to those
   * observers. A plugin uninstall needs this: it stops what it is retracting
   * and nothing else.
   */
  public async stopObservers(keys: ReadonlySet<string>): Promise<void> {
    if (!keys.size) return;
    const groups = this.getObserverGroupsByOrder()
      .map(g => ({...g, bindings: g.bindings.filter(b => keys.has(b.key))}))
      .filter(g => g.bindings.length > 0);
    if (!groups.length) return;
    await this.notifyGroups(['stop'], groups, true);
  }
```

`.filter()` returns a fresh array, which matters: `notifyGroups` reverses
`group.bindings` **in place** at line 229, and passing it a filtered copy keeps
that mutation off the registry's own group objects.

The observers must still be bound when this runs, so the teardown stops first
and unbinds second.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/unmount.acceptance.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/mount.ts packages/core/src/lifecycle-registry.ts \
  packages/plugin/src/__tests__/acceptance/unmount.acceptance.ts \
  packages/plugin/fixtures/observer-plugin
git commit -m "feat(plugin): stop retracting observers through the lifecycle registry

Calling observer.stop() directly bypasses invokeMethod injection, group
ordering, disabled groups and the parallel setting. Gating on app state also
replaces the inherited 'disposers are idempotent so either order is safe'
assumption, which does not hold for third-party plugin observers."
```

---

### Task 7: `report.uninstall()` and `loadPlugin`'s `Installed`

**Files:**

- Modify: `packages/plugin/src/types.ts` (`PluginLoadReport`), `packages/plugin/src/load-plugins.ts`, `packages/plugin/src/load-plugin.ts`
- Test: `packages/plugin/src/__tests__/acceptance/unmount.acceptance.ts`

**Interfaces:**

- Consumes: `buildTeardown` (Task 5)
- Produces: `PluginLoadReport extends Installed`; `loadPlugin(...): Promise<PluginInfo & Installed>`.

- [ ] **Step 1: Write the failing test**

Append to `unmount.acceptance.ts`:

```ts
describe('report.uninstall', () => {
  it('retracts every mounted plugin, and is idempotent', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: fixtures,
      config: {scan: false, dirs: ['.'], enable: ['@fixture/good-plugin']},
    });
    expect(app.isBound('components.GoodComponent')).toBe(true);

    await report.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(false);
    await expect(report.uninstall()).resolves.toBeUndefined();
  });

  it('a strict failure mid-load still retracts what DID mount', async () => {
    const app = new Application();
    let thrown: Error & {report?: PluginLoadReport};
    try {
      await loadPlugins(app, {
        cwd: fixtures,
        config: {
          scan: false,
          dirs: ['.'],
          enable: ['@fixture/good-plugin', '@fixture/broken-plugin'],
          order: ['@fixture/good-plugin', '@fixture/broken-plugin'],
        },
      });
      throw new Error('expected loadPlugins to throw');
    } catch (err) {
      thrown = err as Error & {report?: PluginLoadReport};
    }
    expect(app.isBound('components.GoodComponent')).toBe(true);
    await thrown.report!.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(false);
  });

  it('loadPlugin returns an Installed that round-trips', async () => {
    const app = new Application();
    const installed = await loadPlugin(app, resolve(fixtures, 'good-plugin'));
    expect(app.isBound('components.GoodComponent')).toBe(true);

    await installed.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(false);

    // Re-mount must WORK: app.component() early-returns when the component
    // binding is still present, so a footprint that missed components.* would
    // make this a silent no-op that still reports as mounted.
    const again = await loadPlugin(app, resolve(fixtures, 'good-plugin'));
    expect(again.name).toBe('@fixture/good-plugin');
    expect(app.isBound('components.GoodComponent')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/unmount.acceptance.js
```

Expected: FAIL — `report.uninstall is not a function`.

- [ ] **Step 3: Extend the report type**

In `packages/plugin/src/types.ts`:

```ts
import type {Installed} from '@agentback/core';

export interface PluginLoadReport extends Installed {
  discovered: PluginInfo[];
  mounted: PluginInfo[];
  skipped: Array<PluginInfo & {reason: 'disabled' | 'not-enabled'}>;
  warnings: string[];
  errors: PluginLoadError[];
}
```

- [ ] **Step 4: Attach the teardown in `load-plugins.ts`**

Build the report with a placeholder that is replaced once the loop finishes — the teardown must exist _before_ `fail()` can throw, so the thrown error's attached report carries a working `uninstall`:

```ts
const refs = new Map<string, number>();
const outcomes: MountOutcome[] = [];
const report: PluginLoadReport = {
  discovered,
  mounted: [],
  skipped: gate.skipped,
  warnings,
  errors: [],
  uninstall: () => buildTeardown(app, outcomes, refs)(),
};
```

`buildTeardown` closes over the live `outcomes` array, so the inverse covers
whatever had mounted at the moment `uninstall()` is called — including a
partial load that threw. Build it lazily (as above) rather than eagerly, or the
teardown would snapshot an empty list.

- [ ] **Step 5: Return `Installed` from `load-plugin.ts`**

```ts
export async function loadPlugin(
  app: Application,
  specifier: string,
  options: LoadPluginOptions = {},
): Promise<PluginInfo & Installed> {
  // …existing resolution unchanged…
  const refs = new Map<string, number>();
  const outcome = await tryMount(app, info, ctx, refs);
  if (!outcome.ok) {
    throw new Error(
      `[plugin:${outcome.error.package}] ${outcome.error.kind}: ${outcome.error.message}`,
    );
  }
  return {...info, uninstall: () => buildTeardown(app, [outcome], refs)()};
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm build && pnpm exec vitest run packages/plugin/dist/__tests__
```

Expected: PASS.

- [ ] **Step 7: Update the README's non-idempotence note**

`packages/plugin/README.md:56-58` currently says `loadPlugin` is not idempotent. Replace that paragraph with:

```markdown
`loadPlugin` returns an `Installed`: call `uninstall()` to retract the plugin's
full footprint (bindings unbound, displaced bindings restored, lifecycle
observers stopped when the app is running). Mounting the same plugin twice
without an intervening `uninstall()` still trips the collision guard — the
second mount re-binds the component's own, now app-owned, key. Mount once, or
`uninstall()` first.
```

- [ ] **Step 8: Commit**

```bash
git add packages/plugin/src packages/plugin/README.md
git commit -m "feat(plugin): report.uninstall() and loadPlugin -> Installed

The teardown is built lazily over a live outcomes array, so a strict failure
mid-load attaches a report whose uninstall() retracts the mounts that did
succeed rather than leaving a half-mounted app with no inverse."
```

---

### Task 8: Shared nested components are refcounted

**Files:**

- Test: `packages/plugin/src/__tests__/acceptance/unmount.acceptance.ts`
- Fixtures: `packages/plugin/fixtures/shared-a`, `packages/plugin/fixtures/shared-b`

The mechanism landed in Task 5; this task proves it, because the failure is silent and no other test would catch it.

**Interfaces:**

- Consumes: `referencedComponentKeys`, `refs` (Task 5)
- Produces: nothing new

- [ ] **Step 1: Create the shared fixtures**

`packages/plugin/fixtures/shared-component/index.js` (plain module, not a plugin):

```js
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';

export class SharedComponent {
  constructor() {
    this.bindings = [Binding.bind('services.SharedDep').to('shared')];
  }
}
```

`packages/plugin/fixtures/shared-a/package.json` (and an identical `shared-b` with `SharedBComponent`):

```json
{
  "name": "@fixture/shared-a",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {"plugin": true, "component": "SharedAComponent"}
}
```

`packages/plugin/fixtures/shared-a/index.js`:

```js
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {SharedComponent} from '../shared-component/index.js';

export class SharedAComponent {
  constructor() {
    this.components = [SharedComponent];
  }
}
```

`packages/plugin/fixtures/shared-b/index.js` is the same with `SharedBComponent`.

- [ ] **Step 2: Write the failing test**

Append to `unmount.acceptance.ts`:

```ts
describe('shared nested components', () => {
  it('uninstalling one plugin leaves the other working', async () => {
    const app = new Application();
    const a = await loadPlugin(app, resolve(fixtures, 'shared-a'));
    const b = await loadPlugin(app, resolve(fixtures, 'shared-b'));
    expect(app.isBound('services.SharedDep')).toBe(true);

    await a.uninstall();

    // B still lists SharedComponent. app.component() early-returned for B, so
    // B's binding diff never saw these keys — only the refcount protects them.
    expect(app.isBound('components.SharedComponent')).toBe(true);
    expect(app.isBound('services.SharedDep')).toBe(true);
    expect(app.isBound('components.SharedAComponent')).toBe(false);

    await b.uninstall();
    expect(app.isBound('components.SharedComponent')).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test**

```bash
pnpm build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/unmount.acceptance.js
```

Expected: PASS if Task 5's refcount is correct. If it FAILS with `components.SharedComponent` unbound after `a.uninstall()`, the bug is in `referencedComponentKeys` (it is not walking `.components`) or in `buildTeardown`'s refcount guard.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin/fixtures packages/plugin/src/__tests__
git commit -m "test(plugin): pin the shared nested component refcount

app.component() early-returns for an already-mounted nested component, so the
second plugin's diff is empty for it and a diff-only footprint would let the
first plugin's uninstall silently break the second."
```

---

### Task 9: MCP retraction

An unbound `@mcpServer` currently stays in a built server's `visible` map, and `resolveMember` falls back to `new ctor()` — so an unmounted tool remains callable **and** runs without its injected dependencies.

**Files:**

- Modify: `packages/mcp/src/mcp.server.ts:931-942` (`resolveMember`), and the `tools/list` handler built in `registerAllOn` (`:1100`)
- Test: `packages/mcp/src/__tests__/integration/tool-retraction.integration.ts` (create)

**Interfaces:**

- Consumes: `extensionFilter(MCP_SERVERS)` (already imported in `mcp.server.ts`)
- Produces: `findToolBindingKey(ctx, ctor): string | undefined` — the MCP counterpart of `findControllerBindingKey`, exported from `@agentback/mcp` for tests.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp/src/__tests__/integration/tool-retraction.integration.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {MCPComponent, mcpServer, tool} from '../../index.js';

const Echo = z.object({text: z.string()});

@mcpServer()
class EchoTools {
  @tool('echo', {input: Echo, output: Echo})
  async echo(input: z.infer<typeof Echo>) {
    return input;
  }
}

describe('MCP tool retraction', () => {
  it('an unbound tool class disappears from tools/list', async () => {
    const app = new Application();
    app.component(MCPComponent);
    const binding = app.service(EchoTools);
    await app.start();
    const server = await app.getServer('MCPServer');

    expect((await server.listTools()).tools.map(t => t.name)).toContain('echo');

    app.unbind(binding.key);

    expect((await server.listTools()).tools.map(t => t.name)).not.toContain(
      'echo',
    );
    await app.stop();
  });

  it('calling an unbound tool errors instead of running without DI', async () => {
    const app = new Application();
    app.component(MCPComponent);
    const binding = app.service(EchoTools);
    await app.start();
    const server = await app.getServer('MCPServer');

    app.unbind(binding.key);

    await expect(server.callTool('echo', {text: 'hi'})).rejects.toThrow(
      /not bound|unknown tool/i,
    );
    await app.stop();
  });
});
```

> Adjust `server.listTools()` / `server.callTool()` to the actual `MCPServer`
> test entry points used by the sibling tests in
> `packages/mcp/src/__tests__/` — match whatever those files call rather than
> introducing a new accessor.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm -F @agentback/mcp build && pnpm exec vitest run packages/mcp/dist/__tests__/integration/tool-retraction.integration.js
```

Expected: FAIL — the tool is still listed, and the call succeeds via `new ctor()`.

- [ ] **Step 3: Add the liveness lookup and remove the fallback**

In `packages/mcp/src/mcp.server.ts`, add above `resolveMember`:

```ts
/**
 * The binding key {@link MCPServer.resolveMember} would resolve `ctor`
 * through, or `undefined` when the tool class is not (or no longer) bound.
 * The MCP counterpart of REST's `findControllerBindingKey`: tool maps are
 * baked into a built server, so dispatch consults this per call and an
 * unbound tool is retracted rather than silently served.
 */
export function findToolBindingKey(
  ctx: Context,
  ctor: Function,
): string | undefined {
  return ctx
    .find(extensionFilter(MCP_SERVERS))
    .find(b => b.valueConstructor === ctor)?.key;
}
```

and replace `resolveMember`'s body (lines 931-942):

```ts
  private async resolveMember<T = object>(
    ctor: Function,
    ctx: Context = this.context,
  ): Promise<T> {
    const key = findToolBindingKey(ctx, ctor);
    if (key !== undefined) return ctx.get<T>(key);
    // NO `new ctor()` fallback. Instantiating without DI silently runs user
    // code with un-injected dependencies, and after the dispatch-time liveness
    // gate below the only way to reach this is an unbound (retracted) class.
    throw new Error(
      `MCP tool class ${ctor.name} is not bound. Register it with ` +
        `app.service(${ctor.name}) — or it was retracted by a plugin uninstall.`,
    );
  }
```

- [ ] **Step 4: Gate `tools/list` and `tools/call` on liveness**

In `registerAllOn`, the `visible` map is built once per server, so both
handlers consult liveness at request time.

`tools/list` (currently `Array.from(visible.values(), v => v.entry)`):

```ts
server.setRequestHandler('tools/list', async () => ({
  tools: Array.from(visible.values())
    // Liveness: the map is baked at build time, so a tool whose binding
    // was retracted after that must not still be advertised.
    .filter(v => findToolBindingKey(this.context, v.tool.ctor) !== undefined)
    .map(v => v.entry) as ListToolsResult['tools'],
}));
```

`tools/call` — fold liveness into the existing not-found branch so a retracted
tool reuses the error shape callers already handle:

```ts
const found = visible.get(request.params.name);
if (!found || findToolBindingKey(this.context, found.tool.ctor) === undefined) {
  throw new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `Tool ${request.params.name} not found`,
  );
}
```

Note `resolveMember` is also called for resources (`:434`) and prompts
(`:473`), so removing its fallback covers those too. That is intended and the
same argument applies — every one is discovered through a tagged binding, so
the branch is unreachable except when something was retracted.

Under the stateless default (`protocol: 'both'`) a fresh server is built per
request, so `tools/list` would self-correct; the gate is what makes the session
and stdio paths behave the same way.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm build && pnpm exec vitest run packages/mcp/dist/__tests__
```

Expected: PASS, and every pre-existing MCP test still green. If a test relied
on the `new ctor()` fallback, that test was asserting the bug — read it, and
update it to bind the class.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/mcp.server.ts packages/mcp/src/__tests__/integration/tool-retraction.integration.ts
git commit -m "fix(mcp): retract unbound tools instead of running them without DI

Unbinding an @mcpServer left it in a built server's visible map, and
resolveMember fell back to new ctor() — so an unmounted tool stayed callable
AND ran with un-injected dependencies. Adds the MCP counterpart of REST's
controller liveness gate and removes the fallback."
```

---

### Task 10: `loadPlugin` through the shared install conformance suite

**Files:**

- Test: `packages/plugin/src/__tests__/acceptance/install-conformance.acceptance.ts` (create)
- Fixture: `packages/plugin/fixtures/route-plugin`

**Interfaces:**

- Consumes: `runInstallConformance` from `@agentback/testing`, `loadPlugin` (Task 7)
- Produces: nothing

- [ ] **Step 1: Create a fixture that contributes a REST controller**

`packages/plugin/fixtures/route-plugin/package.json` mirrors `good-plugin` with `"component": "RouteComponent"`. `index.js`:

```js
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {api, get} from '@agentback/openapi';

@api()
class PluginController {
  @get('/plugin-ping')
  async ping() {
    return {ok: true};
  }
}

export class RouteComponent {
  constructor() {
    this.controllers = [PluginController];
  }
}
```

> `fixtures/` is plain JS and not built by `tsc`. If decorators cannot be
> expressed there, author this fixture as a `.ts` file under
> `packages/plugin/src/__tests__/fixtures/` so it compiles with the package,
> and point the test at its `dist` path.

- [ ] **Step 2: Write the conformance test**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {resolve} from 'node:path';
import {RestApplication} from '@agentback/rest';
import {runInstallConformance} from '@agentback/testing';
import {loadPlugin} from '../../load-plugin.js';

const fixtures = resolve(
  new URL('../../..', import.meta.url).pathname,
  'fixtures',
);

runInstallConformance('loadPlugin (route-contributing plugin)', {
  makeApp: () => new RestApplication({rest: {port: 0}}),
  install: app => loadPlugin(app, resolve(fixtures, 'route-plugin')),
  served: ['/plugin-ping'],
});
```

- [ ] **Step 3: Add `@agentback/testing` and `@agentback/rest` as devDependencies of `@agentback/plugin`**

```bash
pnpm -F @agentback/plugin add -D @agentback/testing@workspace:~ @agentback/rest@workspace:~
```

Then add both to `packages/plugin/tsconfig.json`'s `references`, and add the
package to the root `tsconfig.json` references in dependency order if needed.

- [ ] **Step 4: Run it**

```bash
pnpm build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/install-conformance.acceptance.js
```

Expected: PASS on both hosts — install → 2xx, uninstall → 404, reinstall → 2xx.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin package.json pnpm-lock.yaml tsconfig.json
git commit -m "test(plugin): run loadPlugin through runInstallConformance

A plugin that contributes a controller now proves the full revertible-install
contract on both the Express and fetch hosts, reusing the suite the install*
helpers already run rather than adding a second plugin-specific one."
```

---

### Task 11: Documentation surfaces

`CLAUDE.md` requires every doc surface a major feature touches to be updated in the same change.

**Files:**

- Modify: `packages/plugin/README.md`, `docs/packages.md`, `skills/agentback/SKILL.md`, `skills/agentback/references/*.md`, `CLAUDE.md`, `examples/hello-plugin/`

**Interfaces:**

- Consumes: everything above
- Produces: no code

- [ ] **Step 1: `packages/plugin/README.md`**

Add a `## Declaring dependencies` section documenting the `provides`/`inject`
marker fields, that they are advisory (they govern ordering and pre-import
duplicate detection, never resolution), that `order:` is now a tiebreaker, and
that an app-bound key satisfies an inject with no edge. Add a `## Unmounting`
section showing `report.uninstall()` and `loadPlugin(...).uninstall()`, with
the refcount behavior for shared nested components and the app-state gate on
observer stops.

- [ ] **Step 2: `docs/packages.md`** — update the `@agentback/plugin` row to mention unmount + the declared graph.

- [ ] **Step 3: `skills/agentback/SKILL.md`** — update the plugin row in the capability table; add the two new fields to the relevant reference page under `skills/agentback/references/`.

- [ ] **Step 4: `CLAUDE.md`** — update the `plugin` bullet in "New capability packages":

```markdown
- `plugin` — discover, gate, and mount Component-contributing plugins into an Application, and **retract them**: `loadPlugins` returns a report satisfying `Installed`, `loadPlugin` returns `PluginInfo & Installed`. The footprint is the binding snapshot diff `tryMount` already computes (**not** the `fromComponent` tag — `app.component()` instantiates before tagging, so a constructor that binds directly is untagged, and provenance is last-wins so it cannot name a displaced binding). One identity check gates both the unbind and the restore, because an unguarded restore clobbers a third-party shadow exactly as an unguarded unbind deletes one. `components.*` keys are **refcounted** by walking the resolved instance's `.components` tree, since `app.component()` early-returns for an already-mounted nested component and leaves the second plugin's diff empty. A colliding mount rolls back. Observers stop through the lifecycle registry, only while the app is `started`/`initialized`. The marker also takes **`provides`/`inject`** (binding keys): mount order is a topological sort with `order:` demoted to a tiebreaker, and a duplicate `provides` is caught **before any import** — `allowOverride` still permits an intentional one. Declarations are advisory; the container stays the authority, so under-declaring costs ordering, not correctness.
```

- [ ] **Step 5: `pnpm agents-md`** — regenerate `AGENTS.md` from the edited `CLAUDE.md`.

- [ ] **Step 6: `examples/hello-plugin`** — add an `uninstall()` call to the example and one plugin declaring `provides`/`inject`, so both halves have a runnable shape.

- [ ] **Step 7: Full verification**

```bash
pnpm verify
```

Expected: konsistent + build + typecheck:client + test + validate-templates + build:site all green.

- [ ] **Step 8: Commit**

```bash
git add -u && git add examples/hello-plugin
git commit -m "docs(plugin): document unmount and the declared dependency graph

Covers README, packages catalog, agent skill, CLAUDE.md (+ regenerated
AGENTS.md), and the hello-plugin example."
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: decisions 1-2 → Tasks 3-4, 7; decision 3/8 (observers) → Task 6; decision 4 (`inject` = keys) → Tasks 2-3; decision 5 (snapshot diff, not the tag) → Task 5 + the `CLAUDE.md` note in Task 11; decision 6 (independent lifecycles) → Task 6's state gate; decision 7 (Part B kept) → Tasks 2-4; decision 9 (MCP) → Task 9. Eng-review findings: A1 → Task 1, A2 → Tasks 5+8, A3 → Task 3 back-compat test, C1 → Task 5's single `buildTeardown`, C2 → Task 3's gated-out message, X1 → Task 5 rollback, X2 → Task 6, X3 → Task 3 `allowOverride`, X4 → Known limits (no task; documented in Task 11), X5 → Task 9. All 14 spec test rows appear in Tasks 1, 3, 5, 6, 7, 8, 9, 10.

**Placeholder scan.** Two steps carry explicit "resolve during implementation" notes rather than code — Task 6 Step 3 (`LifeCycleRegistry` has no public stop-a-subset entry point, so one must be added) and Task 9 Step 4 (the exact `tools/list` / `tools/call` handler bodies were not read in full). Both name the file, the mechanism, and the constraint. They are flagged deliberately rather than papered over with invented APIs.

**Type consistency.** `revertOwned(ctx, binding, displaced?)` is defined in Task 1 and used with that arity in Task 5. `MountOutcome` / `MountFootprint` / `buildTeardown(app, outcomes, refs)` are defined in Task 5 and used with those signatures in Tasks 6, 7, 8. `sortByGraph(input: SortInput)` is defined in Task 3 and called with the full five-field object in Task 4. `PluginInfo` gains `provides`/`inject` in Task 2, and every later `PluginInfo` literal in this plan includes them.
