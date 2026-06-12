# Plugin Loader (`@agentback/plugin`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone async `loadPlugins(app)` that discovers `Component`-contributing plugins (from npm deps and a `plugins/` dir), gates them through a manifest, mounts them in-process, detects DI-key collisions, and returns an auditable report — fail-closed by default.

**Architecture:** New leaf package `@agentback/plugin`. Discovery reads `package.json` markers **off disk** (never via module resolution, to dodge `exports`-map `ERR_PACKAGE_PATH_NOT_EXPORTED`). A manifest (`enable`/`disable`/`order`/`dirs`/`allowOverride`/`strict`) gates the candidate set. Mounting wraps the existing `app.component()` and snapshots/diffs the context's bound keys to catch silent overrides. Ordering is _not_ the loader's problem — core resolves DI lazily and orders lifecycle by group.

**Tech Stack:** TypeScript 6 (ESM, NodeNext), Zod 4, Vitest 4, `@agentback/core` (`Application`/`Component`), `@agentback/context` (`Context.find`), Node 22 `import.meta.resolve` + `node:fs`.

**Source of truth spec:** `docs/superpowers/specs/2026-06-04-plugin-loader-design.md`

---

## File Structure

```
packages/plugin/
  package.json                         # @agentback/plugin manifest
  tsconfig.json                        # extends base; references core, context, testlab
  src/
    index.ts                           # public surface
    types.ts                           # PluginInfo, PluginLoadError, PluginLoadReport, LoadPluginsOptions, PluginPackageMarker
    config.ts                          # PluginsConfig Zod schema + PluginBindings.CONFIG key
    discovery.ts                       # readMarker, resolvePackageDir, resolveEntry, discoverFromDeps, discoverFromDirs, discover
    gate.ts                            # applyGate(candidates, config) -> {ordered, skipped, warnings}
    load-plugins.ts                    # loadPlugins(app, options) — resolve config, discover, gate, mount, collision-detect, report
    __tests__/
      unit/
        config.unit.ts
        gate.unit.ts
        discovery.unit.ts
      acceptance/
        load-plugins.acceptance.ts
  fixtures/                            # committed plain-ESM .js fixture plugin packages (NOT compiled by tsc)
    good-plugin/{package.json,index.js}
    broken-plugin/{package.json,index.js}      # marker names an export that doesn't exist
    collide-a/{package.json,index.js}          # binds services.Shared
    collide-b/{package.json,index.js}          # also binds services.Shared
    unmarked/{package.json,index.js}           # no AgentBack marker
```

**Why `fixtures/` is hand-written `.js`, not `.ts`:** `tsc` does not copy `package.json`/`.json` into `dist`, and fixture _packages_ need a real on-disk `package.json` next to their entry module. Plain committed `.js` + `package.json` are deterministic, need no build step, and are reachable from the compiled acceptance test via a relative path (`dist/__tests__/acceptance/*.js` → `../../../fixtures`).

---

## Task 0: Scaffold the package

**Files:**

- Create: `packages/plugin/package.json`
- Create: `packages/plugin/tsconfig.json`
- Create: `packages/plugin/src/index.ts`
- Modify: `tsconfig.json` (root references)

- [ ] **Step 1: Create `packages/plugin/package.json`**

```json
{
  "name": "@agentback/plugin",
  "version": "0.0.0",
  "description": "Discover, gate, and mount Component-contributing plugins into an AgentBack Application",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -b",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@agentback/context": "workspace:*",
    "@agentback/core": "workspace:*",
    "tslib": "^2.8.1",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@agentback/testlab": "workspace:*",
    "vitest": "^4.1.6"
  },
  "engines": {
    "node": ">=22.13"
  }
}
```

- [ ] **Step 2: Create `packages/plugin/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "./tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"],
  "references": [
    {"path": "../context"},
    {"path": "../core"},
    {"path": "../testlab"}
  ]
}
```

- [ ] **Step 3: Create `packages/plugin/src/index.ts` (placeholder export so the build has something)**

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

export * from './types.js';
export * from './config.js';
export * from './discovery.js';
export * from './gate.js';
export * from './load-plugins.js';
```

- [ ] **Step 4: Add the package to the root `tsconfig.json` references**

Add this line to the `references` array in the root `tsconfig.json`, after `{"path": "packages/agent-execution-core"}` (it depends only on already-listed `context`/`core`/`testlab`, so any position after those is valid; appending at the end is simplest):

```json
{"path": "packages/plugin"}
```

- [ ] **Step 5: Install + build (expect failure — modules not yet created)**

Run: `pnpm install && pnpm -F @agentback/plugin build`
Expected: FAIL — `Cannot find module './types.js'` etc. This confirms wiring is in place; the next tasks create the modules. (Comment out the `index.ts` exports temporarily if you want a green baseline build, but it's not required.)

- [ ] **Step 6: Commit**

```bash
git add packages/plugin/package.json packages/plugin/tsconfig.json packages/plugin/src/index.ts tsconfig.json pnpm-lock.yaml
git commit -m "chore(plugin): scaffold @agentback/plugin package"
```

---

## Task 1: Types

**Files:**

- Create: `packages/plugin/src/types.ts`

No test of its own (pure type declarations); exercised by every later test.

- [ ] **Step 1: Create `packages/plugin/src/types.ts`**

````ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

/**
 * The `AgentBack` stanza a plugin package adds to its `package.json`.
 *
 * @example
 * ```jsonc
 * "agentback": { "plugin": true, "component": "AgentLoopComponent" }
 * ```
 */
export interface PluginPackageMarker {
  plugin: true;
  /** Named export of the package's main module that is a Component. */
  component: string;
}

/** A discovered (not necessarily mounted) plugin. */
export interface PluginInfo {
  /** Package name (from package.json `name`). */
  name: string;
  /** Package version (from package.json `version`). */
  version: string;
  /** The Component export name to mount. */
  component: string;
  /** Which discovery source found it. */
  source: 'deps' | 'dir';
  /** Resolved package directory (absolute path). */
  path: string;
  /**
   * What `loadPlugins` passes to `import()`:
   * - `source: 'deps'` → the bare package specifier (Node resolves `exports`).
   * - `source: 'dir'`  → a `file://` URL string of the resolved entry module.
   */
  importSpecifier: string;
}

export type PluginLoadErrorKind =
  | 'import'
  | 'missing-export'
  | 'not-a-component'
  | 'key-collision';

export interface PluginLoadError {
  package: string;
  kind: PluginLoadErrorKind;
  message: string;
  /** Populated when `kind === 'key-collision'`. */
  collidingKeys?: string[];
}

export interface PluginLoadReport {
  /** Everything found by either discovery source. */
  discovered: PluginInfo[];
  /** Actually mounted, in mount order. */
  mounted: PluginInfo[];
  /** Discovered but excluded by the gate. */
  skipped: Array<PluginInfo & {reason: 'disabled' | 'not-enabled'}>;
  /** Non-fatal issues (undiscovered enable/order name, missing dir, ...). */
  warnings: string[];
  /** Import/export/collision failures. Under strict mode the first is also thrown. */
  errors: PluginLoadError[];
}

export interface LoadPluginsOptions {
  /** Plugins config; overrides the `PluginBindings.CONFIG` binding when present. */
  config?: unknown;
  /** App root for dep + dir discovery. Default: `process.cwd()`. */
  cwd?: string;
  /** Override `config.strict`. Default: the resolved config value (which defaults `true`). */
  strict?: boolean;
}
````

- [ ] **Step 2: Build to typecheck**

Run: `pnpm -F @agentback/plugin build`
Expected: still FAIL on `./config.js` etc. (created next). `types.js` itself compiles.

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/src/types.ts
git commit -m "feat(plugin): plugin loader public types"
```

---

## Task 2: Config schema

**Files:**

- Create: `packages/plugin/src/config.ts`
- Test: `packages/plugin/src/__tests__/unit/config.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/src/__tests__/unit/config.unit.ts`:

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {PluginsConfig} from '../../config.js';

describe('PluginsConfig', () => {
  it('applies safe defaults when empty', () => {
    expect(PluginsConfig.parse(undefined)).toEqual({
      scan: true,
      dirs: [],
      disable: [],
      order: [],
      allowOverride: [],
      strict: true,
    });
  });

  it('keeps enable optional (undefined means "mount all")', () => {
    const parsed = PluginsConfig.parse({});
    expect(parsed.enable).toBeUndefined();
  });

  it('preserves explicit values', () => {
    const parsed = PluginsConfig.parse({
      scan: false,
      dirs: ['./plugins'],
      enable: ['@acme/foo'],
      disable: ['@acme/bar'],
      order: ['@acme/foo'],
      allowOverride: ['services.X'],
      strict: false,
    });
    expect(parsed.scan).toBe(false);
    expect(parsed.dirs).toEqual(['./plugins']);
    expect(parsed.enable).toEqual(['@acme/foo']);
    expect(parsed.strict).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/config.unit.js`
Expected: FAIL — build error, `config.js` does not exist.

- [ ] **Step 3: Create `packages/plugin/src/config.ts`**

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import {BindingKey} from '@agentback/context';
import {z} from 'zod';

/**
 * Manifest that gates/orders plugin discovery. Two discovery sources
 * (`scan` = declared deps, `dirs` = directory scan) feed one candidate set,
 * which this manifest filters and orders.
 */
export const PluginsConfig = z
  .object({
    /** Discover from the app's declared npm dependencies. */
    scan: z.boolean().default(true),
    /** Additionally scan these directories' immediate subdirs for marked packages. */
    dirs: z.array(z.string()).default([]),
    /** Allowlist — if present, ONLY these packages mount. */
    enable: z.array(z.string()).optional(),
    /** Subtract from the discovered set (after `enable`). */
    disable: z.array(z.string()).default([]),
    /** Mount-order prefix; the rest follow in discovery order. */
    order: z.array(z.string()).default([]),
    /** DI keys a later plugin may intentionally re-bind without a collision halt. */
    allowOverride: z.array(z.string()).default([]),
    /** Fail-closed: a broken plugin / key collision HALTS startup. */
    strict: z.boolean().default(true),
  })
  .default({});

export type PluginsConfigInput = z.input<typeof PluginsConfig>;
export type PluginsConfigResolved = z.output<typeof PluginsConfig>;

export namespace PluginBindings {
  /** Optional binding the app can populate so `loadPlugins` finds the manifest. */
  export const CONFIG = BindingKey.create<PluginsConfigInput>('plugins.config');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/config.unit.js`
Expected: PASS (3 tests). The build still fails to fully link `index.ts` until `discovery`/`gate`/`load-plugins` exist; if the build errors on those, temporarily trim `index.ts` to only `export * from './types.js'; export * from './config.js';` and restore it in Task 6's Step 5. Note this in the commit.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/config.ts packages/plugin/src/__tests__/unit/config.unit.ts packages/plugin/src/index.ts
git commit -m "feat(plugin): PluginsConfig schema (fail-closed defaults)"
```

---

## Task 3: Discovery — marker read + resolver (the ESM footgun guard)

**Files:**

- Create: `packages/plugin/src/discovery.ts`
- Create fixtures: `packages/plugin/fixtures/{good-plugin,unmarked}/{package.json,index.js}`
- Test: `packages/plugin/src/__tests__/unit/discovery.unit.ts`

- [ ] **Step 1: Create the `good-plugin` fixture**

`packages/plugin/fixtures/good-plugin/package.json`:

```json
{
  "name": "@fixture/good-plugin",
  "version": "1.2.3",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {"plugin": true, "component": "GoodComponent"}
}
```

`packages/plugin/fixtures/good-plugin/index.js`:

```js
export class GoodComponent {
  constructor() {
    this.services = [];
  }
}
```

- [ ] **Step 2: Create the `unmarked` fixture**

`packages/plugin/fixtures/unmarked/package.json`:

```json
{
  "name": "@fixture/unmarked",
  "version": "0.0.1",
  "type": "module",
  "main": "index.js"
}
```

`packages/plugin/fixtures/unmarked/index.js`:

```js
export const nothing = true;
```

- [ ] **Step 3: Write the failing test**

Create `packages/plugin/src/__tests__/unit/discovery.unit.ts`:

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {readMarker, resolvePackageDir} from '../../discovery.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/__tests__/unit -> package root -> fixtures
const fixtures = resolve(here, '../../../fixtures');

describe('readMarker', () => {
  it('reads a marked package off disk', () => {
    const info = readMarker(resolve(fixtures, 'good-plugin'), 'dir');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('@fixture/good-plugin');
    expect(info!.version).toBe('1.2.3');
    expect(info!.component).toBe('GoodComponent');
    expect(info!.source).toBe('dir');
  });

  it('returns null for an unmarked package', () => {
    expect(readMarker(resolve(fixtures, 'unmarked'), 'dir')).toBeNull();
  });

  it('returns null for a non-existent dir', () => {
    expect(readMarker(resolve(fixtures, 'does-not-exist'), 'dir')).toBeNull();
  });
});

describe('resolvePackageDir (ESM exports-map regression)', () => {
  it('finds a package dir for a restrictive-exports dependency without ERR_PACKAGE_PATH_NOT_EXPORTED', async () => {
    // @agentback/core is a real dependency and ships exports: { ".": ... } only.
    const dir = await resolvePackageDir(
      '@agentback/core',
      import.meta.url,
    );
    expect(dir).not.toBeNull();
    // The naive approach we are deliberately NOT using must reject:
    await expect(
      import('@agentback/core/package.json', {with: {type: 'json'}}),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/discovery.unit.js`
Expected: FAIL — `discovery.js` does not exist.

- [ ] **Step 5: Create `packages/plugin/src/discovery.ts`**

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {PluginInfo, PluginPackageMarker} from './types.js';
import type {PluginsConfigResolved} from './config.js';

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  'AgentBack'?: Partial<PluginPackageMarker>;
}

function readPackageJson(pkgDir: string): PackageJson | null {
  const file = resolve(pkgDir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * The package's main entry, relative to its dir, honoring a `"."` exports
 * subpath (string or `{import}`/`{default}`) before falling back to `main`
 * then `index.js`.
 */
function entryRelative(pkg: PackageJson): string {
  const exp = pkg.exports as string | Record<string, unknown> | undefined;
  const dot =
    exp && typeof exp === 'object'
      ? (exp as Record<string, unknown>)['.']
      : exp;
  if (typeof dot === 'string') return dot;
  if (dot && typeof dot === 'object') {
    const o = dot as Record<string, unknown>;
    const cond = o.import ?? o.default ?? o.node;
    if (typeof cond === 'string') return cond;
  }
  return pkg.main ?? 'index.js';
}

/**
 * Read the `AgentBack` marker from a package directory **off disk**.
 * Returns null when the dir has no package.json, no marker, or an invalid
 * marker. `importSpecifier` differs by source (see PluginInfo).
 */
export function readMarker(
  pkgDir: string,
  source: 'deps' | 'dir',
  bareSpecifier?: string,
): PluginInfo | null {
  const pkg = readPackageJson(pkgDir);
  if (!pkg) return null;
  const marker = pkg['agentback'];
  if (
    !marker ||
    marker.plugin !== true ||
    typeof marker.component !== 'string'
  ) {
    return null;
  }
  const importSpecifier =
    source === 'deps'
      ? (bareSpecifier ?? pkg.name ?? pkgDir)
      : pathToFileURL(resolve(pkgDir, entryRelative(pkg))).href;
  return {
    name: pkg.name ?? pkgDir,
    version: pkg.version ?? '0.0.0',
    component: marker.component,
    source,
    path: pkgDir,
    importSpecifier,
  };
}

/**
 * Resolve a bare specifier to its package directory WITHOUT touching
 * `pkg/package.json` through module resolution (that throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED against restrictive `exports` maps).
 * We resolve the package's `"."` entry, then walk up to the nearest
 * package.json on disk.
 */
export async function resolvePackageDir(
  specifier: string,
  parentURL: string,
): Promise<string | null> {
  let entryUrl: string;
  try {
    entryUrl = import.meta.resolve(specifier, parentURL);
  } catch {
    return null;
  }
  let dir = dirname(fileURLToPath(entryUrl));
  // Walk up until we find the package.json whose `name` matches the specifier's
  // package, or simply the nearest package.json.
  // 12 levels is far more than any real dist nesting.
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Discover marked plugins from the app's declared dependencies. */
export async function discoverFromDeps(cwd: string): Promise<PluginInfo[]> {
  const appPkg = readPackageJson(cwd);
  const deps = Object.keys(appPkg?.dependencies ?? {});
  const parentURL = pathToFileURL(resolve(cwd, 'package.json')).href;
  const out: PluginInfo[] = [];
  for (const dep of deps) {
    const dir = await resolvePackageDir(dep, parentURL);
    if (!dir) continue;
    const info = readMarker(dir, 'deps', dep);
    if (info) out.push(info);
  }
  return out;
}

/** Discover marked plugins by scanning each dir's immediate subdirectories. */
export function discoverFromDirs(
  dirs: string[],
  cwd: string,
  warnings: string[],
): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const d of dirs) {
    const abs = isAbsolute(d) ? d : resolve(cwd, d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      warnings.push(
        `plugins.dirs: "${d}" is missing or not a directory; skipped`,
      );
      continue;
    }
    for (const entry of readdirSync(abs)) {
      const sub = resolve(abs, entry);
      if (!statSync(sub).isDirectory()) continue;
      const info = readMarker(sub, 'dir');
      if (info) out.push(info);
    }
  }
  return out;
}

/** Run both discovery sources per config into a deduped candidate set. */
export async function discover(
  config: PluginsConfigResolved,
  cwd: string,
  warnings: string[],
): Promise<PluginInfo[]> {
  const found: PluginInfo[] = [];
  if (config.scan) found.push(...(await discoverFromDeps(cwd)));
  if (config.dirs.length)
    found.push(...discoverFromDirs(config.dirs, cwd, warnings));
  // Dedup by package name; first source (deps) wins.
  const seen = new Set<string>();
  const deduped: PluginInfo[] = [];
  for (const info of found) {
    if (seen.has(info.name)) continue;
    seen.add(info.name);
    deduped.push(info);
  }
  return deduped;
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/discovery.unit.js`
Expected: PASS (5 tests), including the exports-map regression.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin/src/discovery.ts packages/plugin/src/__tests__/unit/discovery.unit.ts packages/plugin/fixtures/good-plugin packages/plugin/fixtures/unmarked
git commit -m "feat(plugin): disk-based discovery + exports-map-safe resolver"
```

---

## Task 4: Gate

**Files:**

- Create: `packages/plugin/src/gate.ts`
- Test: `packages/plugin/src/__tests__/unit/gate.unit.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/plugin/src/__tests__/unit/gate.unit.ts`:

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {applyGate} from '../../gate.js';
import {PluginsConfig} from '../../config.js';
import type {PluginInfo} from '../../types.js';

function info(name: string): PluginInfo {
  return {
    name,
    version: '1.0.0',
    component: 'C',
    source: 'deps',
    path: `/x/${name}`,
    importSpecifier: name,
  };
}

const A = info('a');
const B = info('b');
const C = info('c');

describe('applyGate', () => {
  it('mounts everything in discovery order by default', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({}));
    expect(r.ordered.map(p => p.name)).toEqual(['a', 'b', 'c']);
    expect(r.skipped).toEqual([]);
  });

  it('enable acts as an allowlist', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({enable: ['a', 'c']}));
    expect(r.ordered.map(p => p.name)).toEqual(['a', 'c']);
    expect(r.skipped.map(p => p.name)).toEqual(['b']);
    expect(r.skipped[0].reason).toBe('not-enabled');
  });

  it('disable subtracts after enable', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({disable: ['b']}));
    expect(r.ordered.map(p => p.name)).toEqual(['a', 'c']);
    expect(r.skipped.map(p => p.name)).toEqual(['b']);
    expect(r.skipped[0].reason).toBe('disabled');
  });

  it('order prefixes, remainder keeps discovery order', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({order: ['c']}));
    expect(r.ordered.map(p => p.name)).toEqual(['c', 'a', 'b']);
  });

  it('warns when enable names an undiscovered package', () => {
    const r = applyGate([A], PluginsConfig.parse({enable: ['a', 'ghost']}));
    expect(r.warnings.join(' ')).toMatch(/ghost/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/gate.unit.js`
Expected: FAIL — `gate.js` does not exist.

- [ ] **Step 3: Create `packages/plugin/src/gate.ts`**

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import type {PluginsConfigResolved} from './config.js';
import type {PluginInfo} from './types.js';

export interface GateResult {
  ordered: PluginInfo[];
  skipped: Array<PluginInfo & {reason: 'disabled' | 'not-enabled'}>;
  warnings: string[];
}

/**
 * Filter and order discovered candidates per the manifest.
 *
 *   discovered
 *     ├── enable present?  → keep only enabled (rest: skipped 'not-enabled')
 *     ├── disable          → drop (skipped 'disabled')
 *     └── order            → listed names first (in order), remainder by discovery order
 */
export function applyGate(
  discovered: PluginInfo[],
  config: PluginsConfigResolved,
): GateResult {
  const warnings: string[] = [];
  const byName = new Map(discovered.map(p => [p.name, p]));
  const skipped: GateResult['skipped'] = [];

  const enableSet = config.enable ? new Set(config.enable) : null;
  const disableSet = new Set(config.disable);

  if (enableSet) {
    for (const name of enableSet) {
      if (!byName.has(name))
        warnings.push(`plugins.enable: "${name}" was not discovered`);
    }
  }
  for (const name of config.order) {
    if (!byName.has(name))
      warnings.push(`plugins.order: "${name}" was not discovered`);
  }

  let kept: PluginInfo[] = [];
  for (const p of discovered) {
    if (enableSet && !enableSet.has(p.name)) {
      skipped.push({...p, reason: 'not-enabled'});
      continue;
    }
    if (disableSet.has(p.name)) {
      skipped.push({...p, reason: 'disabled'});
      continue;
    }
    kept.push(p);
  }

  if (config.order.length) {
    const orderIndex = new Map(config.order.map((n, i) => [n, i]));
    const inOrder = kept
      .filter(p => orderIndex.has(p.name))
      .sort((a, b) => orderIndex.get(a.name)! - orderIndex.get(b.name)!);
    const rest = kept.filter(p => !orderIndex.has(p.name));
    kept = [...inOrder, ...rest];
  }

  return {ordered: kept, skipped, warnings};
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/unit/gate.unit.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin/src/gate.ts packages/plugin/src/__tests__/unit/gate.unit.ts
git commit -m "feat(plugin): manifest gate (enable/disable/order + warnings)"
```

---

## Task 5: `loadPlugins` orchestration + collision detection

**Files:**

- Create: `packages/plugin/src/load-plugins.ts`
- Create fixtures: `packages/plugin/fixtures/{broken-plugin,collide-a,collide-b}/{package.json,index.js}`
- Test: `packages/plugin/src/__tests__/acceptance/load-plugins.acceptance.ts`

- [ ] **Step 1: Create the `broken-plugin` fixture (marker names a missing export)**

`packages/plugin/fixtures/broken-plugin/package.json`:

```json
{
  "name": "@fixture/broken-plugin",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {"plugin": true, "component": "DoesNotExist"}
}
```

`packages/plugin/fixtures/broken-plugin/index.js`:

```js
export class SomethingElse {}
```

- [ ] **Step 2: Create the `collide-a` and `collide-b` fixtures (both bind `services.Shared`)**

`packages/plugin/fixtures/collide-a/package.json`:

```json
{
  "name": "@fixture/collide-a",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {"plugin": true, "component": "CollideAComponent"}
}
```

`packages/plugin/fixtures/collide-a/index.js`:

```js
class SharedServiceA {}
export class CollideAComponent {
  constructor() {
    // Bind a fixed key so collide-b collides with it.
    this.bindings = [{key: 'services.Shared', value: SharedServiceA}];
  }
}
```

`packages/plugin/fixtures/collide-b/package.json`:

```json
{
  "name": "@fixture/collide-b",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {".": "./index.js"},
  "agentback": {"plugin": true, "component": "CollideBComponent"}
}
```

`packages/plugin/fixtures/collide-b/index.js`:

```js
class SharedServiceB {}
export class CollideBComponent {
  constructor() {
    this.bindings = [{key: 'services.Shared', value: SharedServiceB}];
  }
}
```

> **Note on fixture component shape:** `mountComponent` (core) reads `component.bindings` as an array of `Binding` instances and calls `app.add(b)`. To keep fixtures dependency-free, `load-plugins` does not require real `Binding` objects from fixtures — instead the acceptance test asserts collisions via plugins that contribute the SAME key. Implement `CollideA/BComponent` to return real bindings by importing `Binding` from `@agentback/context`. Update the two `index.js` files to:
>
> ```js
> import {Binding} from '@agentback/context';
> export class CollideAComponent {
>   constructor() {
>     this.bindings = [Binding.bind('services.Shared').to('a')];
>   }
> }
> ```
>
> (and `'b'` for B). `@agentback/context` is resolvable from the fixture because it is a dependency of `@agentback/plugin` and these fixtures are imported within that package's `node_modules` graph at test time.

- [ ] **Step 3: Write the failing acceptance test**

Create `packages/plugin/src/__tests__/acceptance/load-plugins.acceptance.ts`:

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {loadPlugins} from '../../load-plugins.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../../..'); // packages/plugin

describe('loadPlugins (dir source)', () => {
  it('discovers and mounts a good plugin from a plugins dir', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/good-plugin'],
      },
    });
    expect(report.mounted.map(p => p.name)).toEqual(['@fixture/good-plugin']);
    expect(report.errors).toEqual([]);
  });

  it('strict halt: a broken plugin (missing export) throws and is recorded', async () => {
    const app = new Application();
    await expect(
      loadPlugins(app, {
        cwd: pkgRoot,
        config: {
          scan: false,
          dirs: ['fixtures'],
          enable: ['@fixture/broken-plugin'],
          strict: true,
        },
      }),
    ).rejects.toThrow(/broken-plugin|DoesNotExist/);
  });

  it('non-strict: broken plugin lands in errors, others still mount', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/broken-plugin', '@fixture/good-plugin'],
        strict: false,
      },
    });
    expect(report.errors.map(e => e.kind)).toContain('missing-export');
    expect(report.mounted.map(p => p.name)).toContain('@fixture/good-plugin');
  });

  it('key collision is fatal under strict', async () => {
    const app = new Application();
    await expect(
      loadPlugins(app, {
        cwd: pkgRoot,
        config: {
          scan: false,
          dirs: ['fixtures'],
          enable: ['@fixture/collide-a', '@fixture/collide-b'],
          order: ['@fixture/collide-a', '@fixture/collide-b'],
          strict: true,
        },
      }),
    ).rejects.toThrow(/collision|services\.Shared/);
  });

  it('allowOverride permits an intentional re-bind (last wins)', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/collide-a', '@fixture/collide-b'],
        order: ['@fixture/collide-a', '@fixture/collide-b'],
        allowOverride: ['services.Shared'],
        strict: true,
      },
    });
    expect(report.mounted.map(p => p.name)).toEqual([
      '@fixture/collide-a',
      '@fixture/collide-b',
    ]);
    expect(app.getSync('services.Shared')).toBe('b');
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/load-plugins.acceptance.js`
Expected: FAIL — `load-plugins.js` does not exist.

- [ ] **Step 5: Create `packages/plugin/src/load-plugins.ts`**

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import type {Application, Component} from '@agentback/core';
import {PluginBindings, PluginsConfig} from './config.js';
import {applyGate} from './gate.js';
import {discover} from './discovery.js';
import type {
  LoadPluginsOptions,
  PluginInfo,
  PluginLoadError,
  PluginLoadReport,
} from './types.js';

function resolveConfig(app: Application, options: LoadPluginsOptions) {
  if (options.config !== undefined) return PluginsConfig.parse(options.config);
  if (app.isBound(PluginBindings.CONFIG.key)) {
    return PluginsConfig.parse(app.getSync(PluginBindings.CONFIG));
  }
  return PluginsConfig.parse(undefined);
}

/**
 * Snapshot key -> Binding INSTANCE for every binding in the context.
 * Instance identity (not just key presence) is what lets us detect an
 * *override*: `context.add()` does `registry.set(key, binding)`, so re-binding
 * an existing key keeps the key string but swaps the Binding object. A key-set
 * diff would miss that; an instance diff catches it.
 */
function boundBindings(app: Application): Map<string, object> {
  // `find()` with no pattern returns every binding in the context.
  return new Map(app.find().map(b => [b.key, b as object]));
}

/**
 * Discover, gate, and mount plugins into `app`. Fail-closed by default:
 * an import/export failure or a DI-key collision throws (and is recorded in
 * the returned report before throwing). Pass `strict: false` to collect and
 * continue.
 *
 *   resolve config → discover (deps + dirs) → gate → for each:
 *     snapshot bindings → import → read named export → app.component() →
 *     diff bindings (new key OR swapped instance) → collision? → audit → repeat
 */
export async function loadPlugins(
  app: Application,
  options: LoadPluginsOptions = {},
): Promise<PluginLoadReport> {
  const config = resolveConfig(app, options);
  const strict = options.strict ?? config.strict;
  const cwd = options.cwd ?? process.cwd();
  const allowOverride = new Set(config.allowOverride);

  const warnings: string[] = [];
  const discovered = await discover(config, cwd, warnings);
  const gate = applyGate(discovered, config);
  warnings.push(...gate.warnings);

  const report: PluginLoadReport = {
    discovered,
    mounted: [],
    skipped: gate.skipped,
    warnings,
    errors: [],
  };

  // key -> name of the plugin (or '<app>') that currently owns the binding
  const owners = new Map<string, string>();
  for (const key of boundBindings(app).keys()) owners.set(key, '<app>');

  const fail = (err: PluginLoadError): never | void => {
    report.errors.push(err);
    if (strict) {
      const e = new Error(
        `[plugin:${err.package}] ${err.kind}: ${err.message}`,
      );
      (e as Error & {report?: PluginLoadReport}).report = report;
      throw e;
    }
  };

  for (const info of gate.ordered) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(info.importSpecifier)) as Record<string, unknown>;
    } catch (err) {
      fail({package: info.name, kind: 'import', message: String(err)});
      continue;
    }

    const exported = mod[info.component];
    if (typeof exported !== 'function') {
      fail({
        package: info.name,
        kind: 'missing-export',
        message: `named export "${info.component}" is missing or not a class`,
      });
      continue;
    }

    const before = boundBindings(app);
    try {
      app.component(exported as new (...args: never[]) => Component);
    } catch (err) {
      fail({package: info.name, kind: 'import', message: String(err)});
      continue;
    }
    const after = boundBindings(app);

    // A key this plugin touched is either brand-new (absent in `before`) or a
    // re-bind (present in `before` but now a different Binding instance).
    const collisions: string[] = [];
    for (const [key, binding] of after) {
      const priorBinding = before.get(key);
      const touched = priorBinding === undefined || priorBinding !== binding;
      if (!touched) continue;
      const prior = owners.get(key);
      if (prior && prior !== info.name && !allowOverride.has(key)) {
        collisions.push(key);
      }
      owners.set(key, info.name);
    }
    if (collisions.length) {
      fail({
        package: info.name,
        kind: 'key-collision',
        message: `re-binds key(s) owned by another plugin: ${collisions.join(', ')}`,
        collidingKeys: collisions,
      });
      // Note: the binding already happened (last-wins). Under strict we throw above.
      continue;
    }

    report.mounted.push(info);
  }

  return report;
}
```

> **API check (already verified against this codebase):** `Application extends Context`, which provides `isBound(key)` (`context.ts:472`), `getSync(key)` (`:745`), and `find()` (`:591`, no-arg returns all bindings); `component(ctor)` is on `Application` (`application.ts:461`). No change needed — listed here so the implementer can trust the signatures.

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/load-plugins.acceptance.js`
Expected: PASS (5 tests).

- [ ] **Step 7: Run the whole package suite + lint**

Run: `pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist && pnpm lint`
Expected: PASS — all unit + acceptance green, lint clean.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin/src/load-plugins.ts packages/plugin/src/__tests__/acceptance packages/plugin/fixtures/broken-plugin packages/plugin/fixtures/collide-a packages/plugin/fixtures/collide-b
git commit -m "feat(plugin): loadPlugins with fail-closed mount + key-collision detection"
```

---

## Task 6: Mark one real `agent-*` package as a plugin (adoption pattern)

**Files:**

- Modify: `packages/agent-loop/package.json`

This proves end-to-end discovery against a real workspace package and documents the adoption pattern for the rest.

- [ ] **Step 1: Add the marker stanza to `packages/agent-loop/package.json`**

Add this top-level key (the component is already a root export — verified: `packages/agent-loop/src/index.ts:10` re-exports `./component.js`):

```json
  "agentback": { "plugin": true, "component": "AgentLoopComponent" }
```

- [ ] **Step 2: Verify the export name**

Run: `grep -rn "export class .*Component" packages/agent-loop/src/component.ts`
Expected: a class whose name exactly matches the `component` value above. If it differs (e.g. `AgenticLoopComponent`), use the actual name.

- [ ] **Step 3: Write a smoke test for deps discovery against the real package**

Create `packages/plugin/src/__tests__/acceptance/deps-discovery.acceptance.ts`:

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/plugin
// This file is licensed under the MIT License.

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {discoverFromDeps} from '../../discovery.js';

// Discover from agent-loop's own package dir: its declared deps include
// agent-mcp etc. This asserts the deps source + exports-map-safe read work
// against real workspace packages.
const here = dirname(fileURLToPath(import.meta.url));
const agentLoopDir = resolve(here, '../../../../agent-loop');

describe('discoverFromDeps (real workspace packages)', () => {
  it('reads markers from declared deps without throwing on exports maps', async () => {
    const found = await discoverFromDeps(agentLoopDir);
    // At least agent-loop's marked deps are found; the exact set depends on how
    // many agent-* packages carry the marker. Assert the call succeeds and any
    // results are well-formed.
    for (const info of found) {
      expect(info.source).toBe('deps');
      expect(typeof info.component).toBe('string');
    }
  });
});
```

> This test is intentionally tolerant (it asserts shape, not a fixed count) because how many `agent-*` packages carry the marker grows over time. Its real job is to prove the deps path doesn't throw `ERR_PACKAGE_PATH_NOT_EXPORTED` against real restrictive-exports packages.

- [ ] **Step 4: Build + run**

Run: `pnpm -F @agentback/agent-loop build && pnpm -F @agentback/plugin build && pnpm exec vitest run packages/plugin/dist/__tests__/acceptance/deps-discovery.acceptance.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-loop/package.json packages/plugin/src/__tests__/acceptance/deps-discovery.acceptance.ts
git commit -m "feat(agent-loop): mark as an AgentBack plugin; deps-discovery smoke test"
```

---

## Task 7: README + full workspace verification

**Files:**

- Create: `packages/plugin/README.md`

- [ ] **Step 1: Write `packages/plugin/README.md`**

```markdown
# @agentback/plugin

Discover, gate, and mount `Component`-contributing plugins into an AgentBack
`Application`.

\`\`\`ts
import {Application} from '@agentback/core';
import {loadPlugins} from '@agentback/plugin';

const app = new Application(config);
await loadPlugins(app); // discover (deps + dirs) → gate → mount → report
await app.start();
\`\`\`

## Making a package a plugin

Add one stanza to the package's `package.json` (the named export must be a
`Component` on the package's main module):

\`\`\`jsonc
"agentback": { "plugin": true, "component": "MyComponent" }
\`\`\`

## Manifest

Populate `PluginBindings.CONFIG` (or pass `options.config`):

\`\`\`jsonc
{
"scan": true, // discover from declared deps (default)
"dirs": ["./plugins"], // also scan these dirs for marked packages
"enable": ["@acme/foo"], // allowlist — if present, ONLY these mount
"disable": ["@acme/bar"],
"order": ["@acme/foo"],
"allowOverride": ["services.X"],
"strict": true // fail-closed (default): broken plugin / collision HALTS
}
\`\`\`

`loadPlugins` returns a `PluginLoadReport` (`discovered` / `mounted` / `skipped`
/ `warnings` / `errors`) — the synchronous, testable record of what happened.
```

- [ ] **Step 2: Full workspace build + test + lint**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: PASS across the workspace (the new package's suites included; nothing else regressed).

- [ ] **Step 3: Commit**

```bash
git add packages/plugin/README.md
git commit -m "docs(plugin): README for @agentback/plugin"
```

---

## Self-Review notes (carried from spec → plan)

- **Spec coverage:** discovery (deps + dirs, exports-map safe) → Task 3; manifest/gate → Tasks 2,4; fail-closed mount + collision → Task 5; report contract → Tasks 1,5; adoption marker → Task 6; tests for every load-sequence branch → Tasks 2–6 (matches the spec's coverage map, incl. both `[REGRESSION]` tests: exports-map read in Task 3, key collision in Task 5).
- **Deferred (NOT in scope):** sandboxing/capability scoping, `dependsOn`, audit-event transport (report is the contract), hot-reload — see spec.
- **Type consistency:** `PluginInfo`, `PluginLoadError`, `PluginLoadReport`, `PluginsConfigResolved`, `GateResult` names are used identically across tasks.
- **One open API check** is flagged inline in Task 5 Step 5 (`isBound`/`getSync`/`find` naming on `Context`) — resolve by grep before implementing, not by guessing.

```

```
