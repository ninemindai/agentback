# CLI Lifecycle (`agentback new` / `deploy` / `update`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@agentback/cli` from a deploy-only binary into the lifecycle binary — `agentback new` (delegating to `create-agentback`), unchanged `deploy`, and a new `update` that bumps lockstep `@agentback/*` ranges then runs a codemod-or-advisory migration registry.

**Architecture:** `cli.ts` becomes a plain subcommand switch. `new` calls `create-agentback`'s exported `scaffold()` in-process. `update` is a three-phase pipeline (resolve → bump → migrate) in `packages/cli/src/update/`, where migrations share one interface and an advisory is simply a migration with no `apply`. All I/O flows through the existing injected `Exec` seam so tests never spawn a package manager.

**Tech Stack:** TypeScript (ESM), Node ≥22.13, vitest, ts-morph, `@agentback/openapi` (`AgentError`), `create-agentback`.

**Spec:** [docs/proposals/cli-lifecycle.md](../../proposals/cli-lifecycle.md)

**Branch:** `docs/cli-lifecycle-proposal` (already checked out, spec committed at `db749674`).

## Global Constraints

- **ESM-only.** Every relative import carries a `.js` extension, even from `.ts` sources.
- **Copyright header on every new file**, exactly three lines:
  ```ts
  // Copyright NineMind, Inc. 2026. All Rights Reserved.
  // This file is licensed under the MIT License.
  // License text available at https://opensource.org/license/mit/
  ```
  Never write `Copyright IBM Corp.`
- **Tests run against `dist/`, not `src/`.** After editing any `.ts` you MUST `pnpm build` before `pnpm test` sees the change. Test files live at `packages/cli/src/__tests__/unit/*.unit.ts` and are run as `packages/cli/dist/__tests__/unit/*.unit.js`.
- **Prettier style:** single quotes, no bracket spacing (`{foo}` not `{ foo }`), trailing commas everywhere, 80 columns, arrow parens avoided when possible.
- **Test fixtures are built in code** with `mkdtempSync` + `writeFileSync` (see `packages/cli/src/__tests__/unit/detect.unit.ts:14`). Never create on-disk fixture directories under `src/` — `tsc -b` would sweep them in.
- **User-facing failures throw `AgentError`** from `@agentback/openapi`. `cli.ts` already catches it, prints the bare message, and exits 1.
- **Detection never boots the app.** Migrations read source and config files statically only. They must work on a tree that has never been installed or built.
- **`update` is forward-only.** No retroactive codemods. Zero codemods ship in v1; the `apply` seam is proven by tests alone.
- **Node engine floor:** `>=22.13`.

---

## File Structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `packages/cli/src/new.ts` | `agentback new` — arg parsing delegated to `args.ts`, calls `scaffold()`, prints next steps |
| `packages/cli/src/update/versions.ts` | Pure functions: scan `@agentback/*` ranges, resolve `from`, rewrite to a target caret |
| `packages/cli/src/update/package-manager.ts` | Lockfile-based package-manager detection + install command |
| `packages/cli/src/update/migration.ts` | `Migration`, `Finding`, `MigrationContext` types + `selectMigrations` window |
| `packages/cli/src/update/project.ts` | Lazy ts-morph `Project` factory over the app's tsconfig |
| `packages/cli/src/update/migrations/index.ts` | The registry array |
| `packages/cli/src/update/migrations/mcp-stateless-default.ts` | 0.9.0 advisory |
| `packages/cli/src/update/migrations/mcp-stateless-scope-holes.ts` | 0.9.0 advisory |
| `packages/cli/src/update/migrations/mcp-origin-validation.ts` | 0.9.0 advisory |
| `packages/cli/src/update/run-update.ts` | Orchestration: git guard, three phases, report |
| `skills/agentback/references/cli.md` | Agent-facing reference for all three subcommands |

**Modified:**

| Path | Change |
| --- | --- |
| `packages/cli/src/cli.ts:38` | `if (cmd !== 'deploy')` → subcommand switch; extend `USAGE` |
| `packages/cli/src/args.ts` | Add `parseNewArgs`, `parseUpdateArgs` following `parseDeployArgs`'s shape |
| `packages/cli/package.json` | Add `create-agentback` + `ts-morph` to `dependencies` |
| `packages/cli/tsconfig.json` | Add `{"path": "../create-agentback"}` to `references` |
| `skills/agentback/SKILL.md` | Fix stale scaffolder section; add routing-table row |
| `docs/packages.md`, `CLAUDE.md`, `packages/cli/README.md` | Lifecycle scope |

---

### Task 1: Subcommand router and `agentback new`

**Files:**
- Create: `packages/cli/src/new.ts`
- Modify: `packages/cli/src/args.ts` (append), `packages/cli/src/cli.ts:16-40`, `packages/cli/package.json:21-24`, `packages/cli/tsconfig.json`
- Test: `packages/cli/src/__tests__/unit/args.unit.ts` (append), `packages/cli/src/__tests__/unit/new.unit.ts`

**Interfaces:**
- Consumes: `scaffold`, `ScaffoldOptions`, `TEMPLATES`, `TemplateName` from `create-agentback`; `AgentError`, `ErrorCodes` from `@agentback/openapi`.
- Produces: `parseNewArgs(argv: string[]): NewArgs`; `runNew(args: NewArgs, deps: {cwd: string}): string` (returns the created directory).

- [ ] **Step 1: Wire the dependency and project reference**

In `packages/cli/package.json`, add to `dependencies` (keep keys sorted):

```json
  "dependencies": {
    "create-agentback": "workspace:~",
    "esbuild": "~0.28.1",
    "smol-toml": "^1.7.0"
  },
```

In `packages/cli/tsconfig.json`, extend `references`:

```json
  "references": [{"path": "../openapi"}, {"path": "../create-agentback"}],
```

Root `tsconfig.json` already lists `packages/create-agentback` (line 53) before `packages/cli` (line 54), so no reordering is needed. Run `pnpm install`.

- [ ] **Step 2: Write the failing test for `parseNewArgs`**

Append to `packages/cli/src/__tests__/unit/args.unit.ts`:

```ts
describe('parseNewArgs', () => {
  it('defaults to the hybrid template', () => {
    expect(parseNewArgs(['my-svc'])).toMatchObject({
      name: 'my-svc',
      template: 'hybrid',
      capabilities: [],
    });
  });

  it('parses --template and repeated --with', () => {
    const a = parseNewArgs([
      'my-svc',
      '--template',
      'rest',
      '--with',
      'drizzle,auth',
    ]);
    expect(a.template).toBe('rest');
    expect(a.capabilities).toEqual(['drizzle', 'auth']);
  });

  it('parses host options', () => {
    const a = parseNewArgs(['my-svc', '--port', '8080', '--host', '0.0.0.0']);
    expect(a.host).toEqual({port: 8080, host: '0.0.0.0'});
  });

  it('rejects an unknown template', () => {
    expect(() => parseNewArgs(['my-svc', '--template', 'graphql'])).toThrow(
      /unknown template/,
    );
  });

  it('rejects a missing name', () => {
    expect(() => parseNewArgs([])).toThrow(/missing name/);
  });
});
```

Add `parseNewArgs` to the existing import from `../../args.js` at the top of the file.

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/args.unit.js
```

Expected: FAIL — `parseNewArgs is not a function` (or a TS build error that it is not exported).

- [ ] **Step 4: Implement `parseNewArgs`**

Append to `packages/cli/src/args.ts`:

```ts
export interface NewArgs {
  name: string;
  template: TemplateName;
  capabilities: string[];
  host?: {port?: number; host?: string; basePath?: string};
  help: boolean;
}

const NEW_VALUE_FLAGS = new Set([
  '--template',
  '-t',
  '--with',
  '--port',
  '--host',
  '--base-path',
]);

export function parseNewArgs(argv: string[]): NewArgs {
  const out: NewArgs = {
    name: '',
    template: 'hybrid',
    capabilities: [],
    help: false,
  };
  const host: {port?: number; host?: string; basePath?: string} = {};

  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '-h' || f === '--help') {
      out.help = true;
    } else if (f === '--drizzle' || f === '--auth') {
      out.capabilities.push(f.slice(2));
    } else if (f === '-c' || f === '--console') {
      out.capabilities.push('console');
    } else if (NEW_VALUE_FLAGS.has(f)) {
      const v = argv[++i];
      if (v === undefined) bad(`new: ${f} needs a value`);
      if (f === '--template' || f === '-t') {
        if (!(TEMPLATES as readonly string[]).includes(v))
          bad(`new: unknown template '${v}' (supported: ${TEMPLATES.join(', ')})`);
        out.template = v as TemplateName;
      } else if (f === '--with') {
        for (const c of v.split(',').filter(Boolean)) out.capabilities.push(c);
      } else if (f === '--port') {
        const n = Number(v);
        if (!Number.isInteger(n)) bad(`new: --port must be an integer, got '${v}'`);
        host.port = n;
      } else if (f === '--host') {
        host.host = v;
      } else if (f === '--base-path') {
        host.basePath = v;
      }
    } else if (f.startsWith('-')) {
      bad(`new: unknown flag '${f}'`);
    } else if (!out.name) {
      out.name = f;
    } else {
      bad(`new: unexpected argument '${f}'`);
    }
  }

  if (!out.name && !out.help)
    bad('new: missing name. Usage: agentback new <name> [--template hybrid|rest|mcp]');
  if (Object.keys(host).length) out.host = host;
  return out;
}
```

Add to the imports at the top of `args.ts`:

```ts
import {TEMPLATES, type TemplateName} from 'create-agentback';
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/args.unit.js
```

Expected: PASS, including the pre-existing `parseDeployArgs` tests.

- [ ] **Step 6: Write the failing test for `runNew`**

Create `packages/cli/src/__tests__/unit/new.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runNew} from '../../new.js';

describe('runNew', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-new-'));
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  it('scaffolds a hybrid app into cwd', () => {
    const dir = runNew(
      {name: 'my-svc', template: 'hybrid', capabilities: [], help: false},
      {cwd},
    );
    expect(dir).toBe(path.join(cwd, 'my-svc'));
    expect(existsSync(path.join(dir, 'package.json'))).toBe(true);
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as {name: string; dependencies: Record<string, string>};
    expect(pkg.name).toBe('my-svc');
    expect(pkg.dependencies['@agentback/rest']).toBeDefined();
  });

  it('passes capabilities through to scaffold', () => {
    const dir = runNew(
      {name: 'db-svc', template: 'rest', capabilities: ['drizzle'], help: false},
      {cwd},
    );
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as {dependencies: Record<string, string>};
    expect(pkg.dependencies['@agentback/drizzle']).toBeDefined();
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/new.unit.js
```

Expected: FAIL — cannot resolve `../../new.js`.

- [ ] **Step 8: Implement `new.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {scaffold} from 'create-agentback';
import type {NewArgs} from './args.js';

/**
 * Scaffold a new app by delegating to `create-agentback`. The CLI never
 * reimplements or copies templates — `create-agentback` stays the single
 * source of truth, and `npm create agentback` remains the idiomatic entry.
 *
 * @returns the created app directory.
 */
export function runNew(args: NewArgs, deps: {cwd: string}): string {
  const {dir} = scaffold({
    name: args.name,
    template: args.template,
    cwd: deps.cwd,
    capabilities: args.capabilities,
    host: args.host,
  });
  return dir;
}
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/new.unit.js
```

Expected: PASS.

- [ ] **Step 10: Convert `cli.ts` to a subcommand switch**

Replace the `USAGE` constant and the head of `main` in `packages/cli/src/cli.ts`. The `deploy` path must behave exactly as before.

```ts
export const USAGE = `agentback — scaffold, deploy, and upgrade an AgentBack app

Usage:
  agentback new <name> [--template hybrid|rest|mcp] [--with <caps>]
  agentback deploy (vercel|cloudflare) [options]
  agentback update [--to <version>] [--dry-run] [--force]

Run \`agentback <command> --help\` for command-specific options.
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'new') {
      const args = parseNewArgs(rest);
      if (args.help) {
        console.log(NEW_USAGE);
        return 0;
      }
      const dir = runNew(args, {cwd: process.cwd()});
      console.log(`Created ${dir}`);
      console.log('Next: cd, install, build, then start.');
      return 0;
    }
    if (cmd === 'deploy') return await runDeployCommand(rest);
    console.log(USAGE);
    return cmd ? 1 : 0;
  } catch (e) {
    if (e instanceof AgentError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}
```

Move the existing deploy body verbatim into a new local `async function runDeployCommand(rest: string[]): Promise<number>` in the same file, dropping its inner `try/catch` (the outer one now covers it). Define `NEW_USAGE` next to `USAGE` with the flag list from Step 4. Add imports for `parseNewArgs` and `runNew`.

- [ ] **Step 11: Verify deploy did not regress**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/
```

Expected: PASS, all pre-existing `cli.unit.ts` and `args.unit.ts` tests included.

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src/new.ts packages/cli/src/args.ts packages/cli/src/cli.ts \
  packages/cli/package.json packages/cli/tsconfig.json \
  packages/cli/src/__tests__/unit/new.unit.ts \
  packages/cli/src/__tests__/unit/args.unit.ts pnpm-lock.yaml
git commit -m "feat(cli): subcommand router and \`agentback new\` delegating to scaffold()"
```

---

### Task 2: Version resolution and range bumping

**Files:**
- Create: `packages/cli/src/update/versions.ts`
- Test: `packages/cli/src/__tests__/unit/update-versions.unit.ts`

**Interfaces:**
- Produces:
  - `type PackageJson = {dependencies?: Record<string,string>; devDependencies?: Record<string,string>; peerDependencies?: Record<string,string>; [k: string]: unknown}`
  - `scanAgentbackRanges(pkg: PackageJson): Map<string, string>`
  - `resolveFromVersion(ranges: Map<string, string>): {version: string; disagreement: string[]}`
  - `bumpRanges(pkg: PackageJson, to: string): {pkg: PackageJson; changed: string[]}`
  - `compareVersions(a: string, b: string): number`
  - `selfVersion(): string`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/__tests__/unit/update-versions.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {
  bumpRanges,
  compareVersions,
  resolveFromVersion,
  scanAgentbackRanges,
} from '../../update/versions.js';

const PKG = {
  dependencies: {
    '@agentback/core': '^0.9.0',
    '@agentback/rest': '^0.9.0',
    zod: '^4.4.3',
  },
  devDependencies: {'@agentback/testing': '^0.9.0', vitest: '^4.1.0'},
};

describe('scanAgentbackRanges', () => {
  it('collects @agentback/* across dep sections and ignores others', () => {
    const r = scanAgentbackRanges(PKG);
    expect([...r.keys()].sort()).toEqual([
      '@agentback/core',
      '@agentback/rest',
      '@agentback/testing',
    ]);
  });

  it('skips workspace: protocol entries', () => {
    const r = scanAgentbackRanges({
      dependencies: {'@agentback/core': 'workspace:~'},
    });
    expect(r.size).toBe(0);
  });
});

describe('resolveFromVersion', () => {
  it('resolves the common lockstep version', () => {
    expect(resolveFromVersion(scanAgentbackRanges(PKG))).toEqual({
      version: '0.9.0',
      disagreement: [],
    });
  });

  it('reports disagreement and picks the lowest', () => {
    const r = resolveFromVersion(
      new Map([
        ['@agentback/core', '^0.9.0'],
        ['@agentback/rest', '^0.8.0'],
      ]),
    );
    expect(r.version).toBe('0.8.0');
    expect(r.disagreement.sort()).toEqual(['@agentback/core', '@agentback/rest']);
  });

  it('throws when no @agentback/* dependency exists', () => {
    expect(() => resolveFromVersion(new Map())).toThrow(/no @agentback/);
  });
});

describe('bumpRanges', () => {
  it('rewrites every @agentback/* entry and reports what changed', () => {
    const {pkg, changed} = bumpRanges(structuredClone(PKG), '0.10.0');
    expect(pkg.dependencies!['@agentback/core']).toBe('^0.10.0');
    expect(pkg.devDependencies!['@agentback/testing']).toBe('^0.10.0');
    expect(pkg.dependencies!.zod).toBe('^4.4.3');
    expect(changed.sort()).toEqual([
      '@agentback/core',
      '@agentback/rest',
      '@agentback/testing',
    ]);
  });

  it('leaves workspace: entries alone', () => {
    const {changed} = bumpRanges(
      {dependencies: {'@agentback/core': 'workspace:~'}},
      '0.10.0',
    );
    expect(changed).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.9.1', '0.9.1')).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-versions.unit.js
```

Expected: FAIL — cannot resolve `../../update/versions.js`.

- [ ] **Step 3: Implement `versions.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentError, ErrorCodes} from '@agentback/openapi';

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [k: string]: unknown;
}

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
] as const;

/** `^0.9.0` / `~0.9.0` / `0.9.0` → `0.9.0`. Anything else → undefined. */
const RANGE_RE = /^[\^~]?(\d+\.\d+\.\d+)$/;

/** Collect every `@agentback/*` range across all dependency sections. */
export function scanAgentbackRanges(pkg: PackageJson): Map<string, string> {
  const out = new Map<string, string>();
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      // `workspace:` entries are in-repo and are pnpm's problem, not ours.
      if (!name.startsWith('@agentback/')) continue;
      if (range.startsWith('workspace:')) continue;
      out.set(name, range);
    }
  }
  return out;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Derive the app's current version from its `@agentback/*` ranges. Lockstep
 * releases mean they agree; disagreement is reported (not fatal) and the
 * LOWEST version wins, so every migration in between still runs.
 */
export function resolveFromVersion(ranges: Map<string, string>): {
  version: string;
  disagreement: string[];
} {
  const parsed = new Map<string, string>();
  for (const [name, range] of ranges) {
    const m = RANGE_RE.exec(range);
    if (m) parsed.set(name, m[1]);
  }
  if (parsed.size === 0)
    throw new AgentError(
      'update: no @agentback/* dependency with a concrete version range found ' +
        'in package.json. Run this from an AgentBack app root.',
      {code: ErrorCodes.INVALID_INPUT},
    );

  const distinct = [...new Set(parsed.values())].sort(compareVersions);
  return {
    version: distinct[0],
    disagreement: distinct.length > 1 ? [...parsed.keys()].sort() : [],
  };
}

/** Rewrite every `@agentback/*` range to `^<to>`. Mutates and returns `pkg`. */
export function bumpRanges(
  pkg: PackageJson,
  to: string,
): {pkg: PackageJson; changed: string[]} {
  const changed: string[] = [];
  const next = `^${to}`;
  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@agentback/')) continue;
      if (deps[name].startsWith('workspace:')) continue;
      if (deps[name] === next) continue;
      deps[name] = next;
      changed.push(name);
    }
  }
  return {pkg, changed};
}

/** This CLI's own version, read from its package.json next to `dist/`. */
export function selfVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/update/versions.js -> ../../package.json
  const pkgPath = path.resolve(here, '..', '..', 'package.json');
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as {version: string})
    .version;
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-versions.unit.js
```

Expected: PASS (13 assertions across 4 describes).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/update/versions.ts \
  packages/cli/src/__tests__/unit/update-versions.unit.ts
git commit -m "feat(cli): version resolution and lockstep range bumping for update"
```

---

### Task 3: Lockfile-based package-manager detection

**Files:**
- Create: `packages/cli/src/update/package-manager.ts`
- Test: `packages/cli/src/__tests__/unit/update-package-manager.unit.ts`

**Interfaces:**
- Produces: `type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'`; `detectAppPackageManager(root: string): PackageManager`; `installCommand(pm: PackageManager): {cmd: string; args: string[]}`

> **Why not reuse `create-agentback`'s `detectPackageManager()`:** it reads `npm_config_user_agent` (`scaffold.ts:259`) — the *invoking* manager. `agentback update` is normally run via `npx`, which always reports npm, so a pnpm user would be told to run `npm install`. Detection must come from the app's lockfile instead.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/__tests__/unit/update-package-manager.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  detectAppPackageManager,
  installCommand,
} from '../../update/package-manager.js';

describe('detectAppPackageManager', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-pm-'));
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  it('detects pnpm from pnpm-lock.yaml', () => {
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    expect(detectAppPackageManager(root)).toBe('pnpm');
  });

  it('detects yarn from yarn.lock', () => {
    writeFileSync(path.join(root, 'yarn.lock'), '');
    expect(detectAppPackageManager(root)).toBe('yarn');
  });

  it('detects bun from bun.lock', () => {
    writeFileSync(path.join(root, 'bun.lock'), '');
    expect(detectAppPackageManager(root)).toBe('bun');
  });

  it('detects npm from package-lock.json', () => {
    writeFileSync(path.join(root, 'package-lock.json'), '');
    expect(detectAppPackageManager(root)).toBe('npm');
  });

  it('falls back to npm when no lockfile exists', () => {
    expect(detectAppPackageManager(root)).toBe('npm');
  });

  it('prefers pnpm when several lockfiles are present', () => {
    writeFileSync(path.join(root, 'package-lock.json'), '');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    expect(detectAppPackageManager(root)).toBe('pnpm');
  });
});

describe('installCommand', () => {
  it('maps each manager to its install invocation', () => {
    expect(installCommand('pnpm')).toEqual({cmd: 'pnpm', args: ['install']});
    expect(installCommand('yarn')).toEqual({cmd: 'yarn', args: ['install']});
    expect(installCommand('bun')).toEqual({cmd: 'bun', args: ['install']});
    expect(installCommand('npm')).toEqual({cmd: 'npm', args: ['install']});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-package-manager.unit.js
```

Expected: FAIL — cannot resolve `../../update/package-manager.js`.

- [ ] **Step 3: Implement `package-manager.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import path from 'node:path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

/**
 * Ordered so the most specific lockfile wins — a repo carrying both
 * `package-lock.json` and `pnpm-lock.yaml` is a pnpm repo with a stale
 * npm lockfile, not the other way around.
 */
const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/**
 * Detect the app's package manager from its lockfile. Deliberately NOT
 * `create-agentback`'s `detectPackageManager()` — that reads the invoking
 * manager from npm's user-agent, which is always npm under `npx`.
 */
export function detectAppPackageManager(root: string): PackageManager {
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(path.join(root, file))) return pm;
  }
  return 'npm';
}

export function installCommand(pm: PackageManager): {
  cmd: string;
  args: string[];
} {
  return {cmd: pm, args: ['install']};
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-package-manager.unit.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/update/package-manager.ts \
  packages/cli/src/__tests__/unit/update-package-manager.unit.ts
git commit -m "feat(cli): lockfile-based package-manager detection for update"
```

---

### Task 4: Migration types and the selection window

**Files:**
- Create: `packages/cli/src/update/migration.ts`
- Test: `packages/cli/src/__tests__/unit/update-migration.unit.ts`

**Interfaces:**
- Consumes: `compareVersions` from `./versions.js`.
- Produces: `Finding`, `MigrationContext`, `Migration`, `selectMigrations(all: readonly Migration[], from: string, to: string): Migration[]`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/src/__tests__/unit/update-migration.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {selectMigrations, type Migration} from '../../update/migration.js';

const m = (id: string, version: string): Migration => ({
  id,
  version,
  title: id,
  detect: () => [],
});

const ALL = [m('a', '0.8.0'), m('b', '0.9.0'), m('c', '0.10.0')];

describe('selectMigrations', () => {
  it('selects the half-open window (from, to]', () => {
    expect(selectMigrations(ALL, '0.8.0', '0.10.0').map(x => x.id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('excludes the from version itself', () => {
    expect(selectMigrations(ALL, '0.9.0', '0.10.0').map(x => x.id)).toEqual([
      'c',
    ]);
  });

  it('returns nothing when already current', () => {
    expect(selectMigrations(ALL, '0.10.0', '0.10.0')).toEqual([]);
  });

  it('orders by version ascending regardless of registry order', () => {
    const shuffled = [ALL[2], ALL[0], ALL[1]];
    expect(selectMigrations(shuffled, '0.7.0', '0.10.0').map(x => x.id)).toEqual(
      ['a', 'b', 'c'],
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-migration.unit.js
```

Expected: FAIL — cannot resolve `../../update/migration.js`.

- [ ] **Step 3: Implement `migration.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Project} from 'ts-morph';
import {compareVersions, type PackageJson} from './versions.js';

export interface Finding {
  /** App-relative path, when the finding points at a file. */
  file?: string;
  line?: number;
  /** What was found. */
  message: string;
  /** What the user should do — the migration note, when `apply` cannot. */
  action: string;
}

export interface MigrationContext {
  /** App root. Every `Finding.file` is relative to it. */
  root: string;
  /** Parsed package.json, post-bump. */
  pkg: PackageJson;
  /**
   * ts-morph project over the app's sources. Lazy: an advisory that only
   * reads package.json or a config file never pays to parse the source tree.
   */
  project(): Project;
  from: string;
  to: string;
}

export interface Migration {
  /** Stable slug, e.g. 'mcp-stateless-default'. */
  id: string;
  /** The released version that introduced the break. */
  version: string;
  title: string;
  /** Static analysis only — never boots the app. */
  detect(ctx: MigrationContext): Finding[];
  /** Present ⇒ codemod. Absent ⇒ advisory. */
  apply?(ctx: MigrationContext): void;
}

/**
 * Migrations that apply when moving `from` → `to`, as the half-open window
 * `(from, to]`: the version you are already on introduced nothing new for you,
 * the version you are moving to did.
 */
export function selectMigrations(
  all: readonly Migration[],
  from: string,
  to: string,
): Migration[] {
  return all
    .filter(
      x =>
        compareVersions(x.version, from) > 0 &&
        compareVersions(x.version, to) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-migration.unit.js
```

Expected: PASS. (The `ts-morph` type-only import resolves once Task 5 adds the dependency; if the build fails here, do Task 5 Step 1 first.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/update/migration.ts \
  packages/cli/src/__tests__/unit/update-migration.unit.ts
git commit -m "feat(cli): migration registry types and (from, to] selection window"
```

---

### Task 5: The ts-morph seam and its formatting-fidelity guard

**Files:**
- Create: `packages/cli/src/update/project.ts`
- Modify: `packages/cli/package.json` (add `ts-morph`)
- Test: `packages/cli/src/__tests__/integration/update-project.integration.ts`

**Interfaces:**
- Produces: `createLazyProject(root: string): () => Project`

> This task is why the plan ships an `apply` seam with zero real codemods. Scaffolded apps carry **no prettier** (`templates/hybrid/package.json` has no formatter), so a reflowed file is permanent, user-visible damage with nothing to normalize it. The fidelity assertion must exist before the first real transform in 0.10, not alongside it.

- [ ] **Step 1: Add the dependency**

In `packages/cli/package.json` `dependencies` (keys sorted):

```json
  "dependencies": {
    "create-agentback": "workspace:~",
    "esbuild": "~0.28.1",
    "smol-toml": "^1.7.0",
    "ts-morph": "^28.0.0"
  },
```

Run `pnpm install`. If pnpm rejects the version with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, pin one patch older rather than adding a `minimumReleaseAgeExclude` entry.

- [ ] **Step 2: Write the failing fidelity test**

Create `packages/cli/src/__tests__/integration/update-project.integration.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createLazyProject} from '../../update/project.js';

// Deliberately idiosyncratic formatting: 4-space indent, no trailing commas,
// a blank line inside the class, and an aligned comment. A codemod that
// reflows the file destroys all of it, and a scaffolded app has no prettier
// to put it back.
const SOURCE = `import {api, get} from '@agentback/openapi';

@api({basePath: '/v1'})
export class GreetController {
    // greet the caller
    @get('/hello')
    async hello() {
        return {ok: true}
    }

    async unused() {
        return 1
    }
}
`;

describe('createLazyProject', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-proj-'));
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'greet.ts'), SOURCE);
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  it('does not parse the source tree until called', () => {
    let built = false;
    const project = createLazyProject(root, () => {
      built = true;
    });
    expect(built).toBe(false);
    project();
    expect(built).toBe(true);
  });

  it('returns the same Project instance across calls', () => {
    const project = createLazyProject(root);
    expect(project()).toBe(project());
  });

  it('leaves untouched regions byte-identical after a transform', () => {
    const project = createLazyProject(root);
    const file = project().getSourceFileOrThrow('src/greet.ts');

    // Synthetic transform standing in for a future real codemod: rename one
    // method. Everything else in the file must survive unchanged.
    file.getClassOrThrow('GreetController').getMethodOrThrow('unused').rename(
      'renamed',
    );
    file.saveSync();

    const after = readFileSync(path.join(root, 'src', 'greet.ts'), 'utf8');
    expect(after).toBe(SOURCE.replace('async unused()', 'async renamed()'));
  });
});
```

- [ ] **Step 3: Run to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/integration/update-project.integration.js
```

Expected: FAIL — cannot resolve `../../update/project.js`.

- [ ] **Step 4: Implement `project.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import path from 'node:path';
import {Project} from 'ts-morph';

/**
 * Build a ts-morph `Project` over the app's sources, lazily.
 *
 * ts-morph vendors its own TypeScript, so this is immune to whatever
 * `typescript` version the app pins — which matters given the framework's own
 * TS 6 / TS 7 side-by-side arrangement and the template's `typescript: ^5.9.0`.
 *
 * @param onBuild test seam, invoked the first time the project is constructed.
 */
export function createLazyProject(
  root: string,
  onBuild?: () => void,
): () => Project {
  let project: Project | undefined;
  return () => {
    if (project) return project;
    const tsconfig = path.join(root, 'tsconfig.json');
    project = existsSync(tsconfig)
      ? new Project({tsConfigFilePath: tsconfig})
      : new Project({skipAddingFilesFromTsConfig: true});
    if (!existsSync(tsconfig)) {
      project.addSourceFilesAtPaths(path.join(root, 'src/**/*.ts'));
    }
    onBuild?.();
    return project;
  };
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/integration/update-project.integration.js
```

Expected: PASS. **If the fidelity test fails**, do not weaken the assertion — that failure is the whole point of the task. Narrow the transform's blast radius (prefer `rename`/`replaceWithText` on the smallest node) until untouched regions survive, and record what you found in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/update/project.ts packages/cli/package.json \
  packages/cli/src/__tests__/integration/update-project.integration.ts pnpm-lock.yaml
git commit -m "feat(cli): lazy ts-morph project seam with a formatting-fidelity guard"
```

---

### Task 6: The three seed advisories

**Files:**
- Create: `packages/cli/src/update/migrations/mcp-stateless-default.ts`, `mcp-stateless-scope-holes.ts`, `mcp-origin-validation.ts`, `index.ts`
- Test: `packages/cli/src/__tests__/unit/update-advisories.unit.ts`

**Interfaces:**
- Consumes: `Migration`, `Finding`, `MigrationContext` from `../migration.js`; `createLazyProject` from `../project.js`.
- Produces: `MIGRATIONS: readonly Migration[]` from `packages/cli/src/update/migrations/index.js`.

> Every advisory needs a **negative** case. A registry that cries wolf is worse than no registry, because users learn to skip the output.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/__tests__/unit/update-advisories.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {createLazyProject} from '../../update/project.js';
import {MIGRATIONS} from '../../update/migrations/index.js';
import type {Migration, MigrationContext} from '../../update/migration.js';

function byId(id: string): Migration {
  const m = MIGRATIONS.find(x => x.id === id);
  if (!m) throw new Error(`no migration ${id}`);
  return m;
}

describe('seed advisories', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-adv-'));
    mkdirSync(path.join(root, 'src'));
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  function ctx(): MigrationContext {
    return {
      root,
      pkg: {},
      project: createLazyProject(root),
      from: '0.8.0',
      to: '0.9.0',
    };
  }

  function src(body: string): void {
    writeFileSync(path.join(root, 'src', 'app.ts'), body);
  }

  it('all three seed advisories are registered at 0.9.0 with no apply', () => {
    const ids = MIGRATIONS.map(m => m.id).sort();
    expect(ids).toEqual([
      'mcp-origin-validation',
      'mcp-stateless-default',
      'mcp-stateless-scope-holes',
    ]);
    for (const m of MIGRATIONS) {
      expect(m.version).toBe('0.9.0');
      expect(m.apply).toBeUndefined();
    }
  });

  describe('mcp-stateless-default', () => {
    it('flags eventStore set without an explicit protocol', () => {
      src(`installMcpHttp(app, {eventStore: myStore});`);
      const f = byId('mcp-stateless-default').detect(ctx());
      expect(f).toHaveLength(1);
      expect(f[0].action).toMatch(/protocol/);
    });

    it('flags code reading Mcp-Session-Id', () => {
      src(`const id = req.headers.get('Mcp-Session-Id');`);
      expect(byId('mcp-stateless-default').detect(ctx())).toHaveLength(1);
    });

    it('stays silent when protocol is named explicitly', () => {
      src(`installMcpHttp(app, {eventStore: myStore, protocol: 'legacy'});`);
      expect(byId('mcp-stateless-default').detect(ctx())).toEqual([]);
    });

    it('stays silent on an app that does not mount MCP over HTTP', () => {
      src(`export class Foo {}`);
      expect(byId('mcp-stateless-default').detect(ctx())).toEqual([]);
    });
  });

  describe('mcp-stateless-scope-holes', () => {
    it('flags scoped tools under optional auth', () => {
      src(
        `installMcpHttp(app, {strategyAuth: {required: false}});\n` +
          `class T { @tool('x', {scope: 'admin'}) run() {} }`,
      );
      const f = byId('mcp-stateless-scope-holes').detect(ctx());
      expect(f.some(x => /scope/.test(x.message))).toBe(true);
    });

    it('flags confirm: tools with no CONFIRMATION_STORE binding', () => {
      src(`class T { @tool('confirm:delete') run() {} }`);
      const f = byId('mcp-stateless-scope-holes').detect(ctx());
      expect(f.some(x => /CONFIRMATION_STORE/.test(x.action))).toBe(true);
    });

    it('stays silent when a CONFIRMATION_STORE is bound', () => {
      src(
        `class T { @tool('confirm:delete') run() {} }\n` +
          `app.bind(MCPBindings.CONFIRMATION_STORE).to(redisStore);`,
      );
      const f = byId('mcp-stateless-scope-holes').detect(ctx());
      expect(f.some(x => /CONFIRMATION_STORE/.test(x.action))).toBe(false);
    });

    it('stays silent on an app with neither pattern', () => {
      src(`class T { @tool('plain') run() {} }`);
      expect(byId('mcp-stateless-scope-holes').detect(ctx())).toEqual([]);
    });
  });

  describe('mcp-origin-validation', () => {
    it('flags a wildcard cors with no allowedOrigins', () => {
      src(`installMcpHttp(app, {});\nconst c = {rest: {cors: true}};`);
      expect(byId('mcp-origin-validation').detect(ctx())).toHaveLength(1);
    });

    it('stays silent when allowedOrigins is set', () => {
      src(
        `installMcpHttp(app, {allowedOrigins: ['x.dev']});\n` +
          `const c = {rest: {cors: true}};`,
      );
      expect(byId('mcp-origin-validation').detect(ctx())).toEqual([]);
    });

    it('stays silent without a wildcard cors', () => {
      src(`installMcpHttp(app, {});`);
      expect(byId('mcp-origin-validation').detect(ctx())).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-advisories.unit.js
```

Expected: FAIL — cannot resolve `../../update/migrations/index.js`.

- [ ] **Step 3: Implement a shared source-scan helper plus the three advisories**

Create `packages/cli/src/update/migrations/mcp-stateless-default.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import path from 'node:path';
import {SyntaxKind, type CallExpression, type SourceFile} from 'ts-morph';
import type {Finding, Migration, MigrationContext} from '../migration.js';

/** Every `installMcpHttp(...)` call in the app, with its options literal. */
export function installMcpHttpCalls(
  ctx: MigrationContext,
): Array<{file: SourceFile; call: CallExpression; options: string[]}> {
  const out: Array<{
    file: SourceFile;
    call: CallExpression;
    options: string[];
  }> = [];
  for (const file of ctx.project().getSourceFiles()) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'installMcpHttp') continue;
      const literal = call
        .getArguments()
        .find(a => a.isKind(SyntaxKind.ObjectLiteralExpression));
      const options = literal
        ? literal
            .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
            .getProperties()
            .map(p => p.getSymbol()?.getName() ?? p.getText().split(':')[0].trim())
        : [];
      out.push({file, call, options});
    }
  }
  return out;
}

export function rel(ctx: MigrationContext, file: SourceFile): string {
  return path.relative(ctx.root, file.getFilePath());
}

export const mcpStatelessDefault: Migration = {
  id: 'mcp-stateless-default',
  version: '0.9.0',
  title: "MCP over HTTP defaults to protocol: 'both' (stateless)",
  detect(ctx) {
    const findings: Finding[] = [];

    for (const {file, call, options} of installMcpHttpCalls(ctx)) {
      if (options.includes('eventStore') && !options.includes('protocol')) {
        findings.push({
          file: rel(ctx, file),
          line: call.getStartLineNumber(),
          message:
            'installMcpHttp sets `eventStore` (resumable SSE, a session ' +
            'feature) without naming a `protocol`.',
          action:
            "0.9.0 keeps this mount on 'legacy' so the capability is not " +
            "silently dropped. Name `protocol: 'legacy'` explicitly to make " +
            'that intent visible, or migrate off eventStore to adopt the ' +
            'stateless default.',
        });
      }
    }

    for (const file of ctx.project().getSourceFiles()) {
      const text = file.getFullText();
      const idx = text.search(/mcp-session-id/i);
      if (idx === -1) continue;
      findings.push({
        file: rel(ctx, file),
        line: file.getLineAndColumnAtPos(idx).line,
        message: 'Code reads or sets the `Mcp-Session-Id` header.',
        action:
          "Sessions do not exist under the 0.9.0 default (protocol: 'both'). " +
          "Either remove the session dependency or pin protocol: 'legacy'.",
      });
    }

    return findings;
  },
};
```

Create `packages/cli/src/update/migrations/mcp-stateless-scope-holes.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Finding, Migration} from '../migration.js';
import {rel} from './mcp-stateless-default.js';

export const mcpStatelessScopeHoles: Migration = {
  id: 'mcp-stateless-scope-holes',
  version: '0.9.0',
  title: 'Stateless scope filtering and confirmation-store lifetime',
  detect(ctx) {
    const findings: Finding[] = [];
    const files = ctx.project().getSourceFiles();
    const all = files.map(f => f.getFullText()).join('\n');

    const optionalAuth = /required\s*:\s*false/.test(all);
    for (const file of files) {
      const text = file.getFullText();
      if (!optionalAuth) break;
      if (!/@tool\([^)]*scope\s*:/s.test(text)) continue;
      findings.push({
        file: rel(ctx, file),
        message:
          'Scoped @tool declarations combined with `required: false` auth.',
        action:
          'Under the stateless default an anonymous caller must be filtered ' +
          'with an empty scope list, not an absent one. Verify scoped tools ' +
          'are invisible to anonymous callers after upgrading — @tool({scope}) ' +
          'is a visibility gate and nothing downstream re-checks it.',
      });
    }

    const usesConfirm = /@tool\(\s*['"`]confirm:/.test(all);
    const bindsStore = /CONFIRMATION_STORE/.test(all);
    if (usesConfirm && !bindsStore) {
      findings.push({
        message: 'App declares `confirm:` tools but binds no confirmation store.',
        action:
          'A confirm: round trip spans two requests. Bind ' +
          'MCPBindings.CONFIRMATION_STORE explicitly (Redis for multi-instance) ' +
          'so tokens survive between them.',
      });
    }

    return findings;
  },
};
```

Create `packages/cli/src/update/migrations/mcp-origin-validation.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Finding, Migration} from '../migration.js';
import {installMcpHttpCalls, rel} from './mcp-stateless-default.js';

export const mcpOriginValidation: Migration = {
  id: 'mcp-origin-validation',
  version: '0.9.0',
  title: 'Origin is validated by default on the stateless mount',
  detect(ctx) {
    const findings: Finding[] = [];
    const wildcardCors = ctx
      .project()
      .getSourceFiles()
      .some(f => /cors\s*:\s*(true|\([^)]*\)\s*=>)/.test(f.getFullText()));
    if (!wildcardCors) return findings;

    for (const {file, call, options} of installMcpHttpCalls(ctx)) {
      if (options.includes('allowedOrigins')) continue;
      findings.push({
        file: rel(ctx, file),
        line: call.getStartLineNumber(),
        message:
          'installMcpHttp has no `allowedOrigins`, and `rest.cors` enumerates ' +
          'nothing (wildcard or callback).',
        action:
          'When allowedOrigins is unset the policy is derived from rest.cors. ' +
          'A callback or true wildcard enumerates nothing, so validation warns ' +
          'and stays OFF. Set allowedOrigins explicitly to get protection.',
      });
    }
    return findings;
  },
};
```

Create `packages/cli/src/update/migrations/index.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Migration} from '../migration.js';
import {mcpOriginValidation} from './mcp-origin-validation.js';
import {mcpStatelessDefault} from './mcp-stateless-default.js';
import {mcpStatelessScopeHoles} from './mcp-stateless-scope-holes.js';

/**
 * Every migration, ordered by version. v1 ships advisories only — no released
 * version ever shipped a source-mechanical breaking change, so there is
 * nothing to codemod. See docs/proposals/cli-lifecycle.md.
 */
export const MIGRATIONS: readonly Migration[] = [
  mcpStatelessDefault,
  mcpStatelessScopeHoles,
  mcpOriginValidation,
];
```

- [ ] **Step 4: Run to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-advisories.unit.js
```

Expected: PASS — 12 tests, every advisory covered by at least one positive and one negative case.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/update/migrations/ \
  packages/cli/src/__tests__/unit/update-advisories.unit.ts
git commit -m "feat(cli): three 0.9.0 seed advisories with positive and negative coverage"
```

---

### Task 7: `runUpdate` orchestration and CLI wiring

**Files:**
- Create: `packages/cli/src/update/run-update.ts`
- Modify: `packages/cli/src/args.ts` (add `parseUpdateArgs`), `packages/cli/src/cli.ts` (route `update`)
- Test: `packages/cli/src/__tests__/unit/update-run.unit.ts`, `packages/cli/src/__tests__/unit/args.unit.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 2–6, plus `Exec` from `../exec.js`.
- Produces:
  - `parseUpdateArgs(argv: string[]): UpdateArgs` where `UpdateArgs = {to?: string; dryRun: boolean; force: boolean; help: boolean}`
  - `runUpdate(args: UpdateArgs, deps: UpdateDeps): Promise<UpdateReport>` where `UpdateDeps = {exec: Exec; cwd: string; selfVersion: string}` and `UpdateReport = {from: string; to: string; changed: string[]; findings: Array<Finding & {migration: string}>; installed: boolean; dryRun: boolean}`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/__tests__/unit/update-run.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Exec, ExecResult} from '../../exec.js';
import {runUpdate} from '../../update/run-update.js';

function stubExec(clean = true): {exec: Exec; calls: string[][]} {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const res: ExecResult = {code: 0, stdout: '', stderr: ''};
    if (cmd === 'git') return {...res, stdout: clean ? '' : ' M src/app.ts\n'};
    return res;
  };
  return {exec, calls};
}

const PKG = {
  name: 'my-svc',
  dependencies: {'@agentback/core': '^0.9.0', zod: '^4.4.3'},
  devDependencies: {'@agentback/testing': '^0.9.0'},
};

describe('runUpdate', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-upd-'));
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export class A {}\n');
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify(PKG, null, 2) + '\n',
    );
    writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '');
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  it('bumps every @agentback/* range and installs with the app manager', async () => {
    const {exec, calls} = stubExec();
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );

    expect(r.from).toBe('0.9.0');
    expect(r.to).toBe('0.10.0');
    expect(r.changed.sort()).toEqual(['@agentback/core', '@agentback/testing']);

    const pkg = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    ) as typeof PKG;
    expect(pkg.dependencies['@agentback/core']).toBe('^0.10.0');
    expect(pkg.dependencies.zod).toBe('^4.4.3');
    expect(calls).toContainEqual(['pnpm', 'install']);
    expect(r.installed).toBe(true);
  });

  it('writes nothing and installs nothing under --dry-run', async () => {
    const {exec, calls} = stubExec();
    const before = readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const r = await runUpdate(
      {dryRun: true, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );

    expect(readFileSync(path.join(cwd, 'package.json'), 'utf8')).toBe(before);
    expect(calls).not.toContainEqual(['pnpm', 'install']);
    expect(r.installed).toBe(false);
    expect(r.changed.sort()).toEqual(['@agentback/core', '@agentback/testing']);
  });

  it('refuses a dirty git tree without --force', async () => {
    const {exec} = stubExec(false);
    await expect(
      runUpdate(
        {dryRun: false, force: false, help: false, to: '0.10.0'},
        {exec, cwd, selfVersion: '0.10.0'},
      ),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it('allows a dirty tree under --force', async () => {
    const {exec} = stubExec(false);
    const r = await runUpdate(
      {dryRun: false, force: true, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.installed).toBe(true);
  });

  it('refuses when the CLI is older than the target', async () => {
    const {exec} = stubExec();
    await expect(
      runUpdate(
        {dryRun: false, force: false, help: false, to: '0.11.0'},
        {exec, cwd, selfVersion: '0.10.0'},
      ),
    ).rejects.toThrow(/npx @agentback\/cli@latest/);
  });

  it('defaults the target to the running CLI version', async () => {
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: true, force: false, help: false},
      {exec, cwd, selfVersion: '0.12.0'},
    );
    expect(r.to).toBe('0.12.0');
  });
});
```

Append to `packages/cli/src/__tests__/unit/args.unit.ts`:

```ts
describe('parseUpdateArgs', () => {
  it('defaults to no target, no dry-run, no force', () => {
    expect(parseUpdateArgs([])).toEqual({
      dryRun: false,
      force: false,
      help: false,
    });
  });

  it('parses --to, --dry-run and --force', () => {
    expect(parseUpdateArgs(['--to', '0.10.0', '--dry-run', '--force'])).toEqual({
      to: '0.10.0',
      dryRun: true,
      force: true,
      help: false,
    });
  });

  it('rejects a non-exact --to', () => {
    expect(() => parseUpdateArgs(['--to', '^0.10'])).toThrow(/exact version/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseUpdateArgs(['--yolo'])).toThrow(/unknown flag/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/update-run.unit.js
```

Expected: FAIL — cannot resolve `../../update/run-update.js`.

- [ ] **Step 3: Implement `parseUpdateArgs`**

Append to `packages/cli/src/args.ts`:

```ts
export interface UpdateArgs {
  to?: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

/** `--to` takes an exact version; lockstep makes a range meaningless. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+$/;

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const out: UpdateArgs = {dryRun: false, force: false, help: false};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--to') {
      const v = argv[++i];
      if (v === undefined) bad('update: --to needs a value');
      if (!EXACT_VERSION_RE.test(v))
        bad(`update: --to needs an exact version like 0.10.0, got '${v}'`);
      out.to = v;
    } else if (f === '--dry-run') {
      out.dryRun = true;
    } else if (f === '--force') {
      out.force = true;
    } else if (f === '-h' || f === '--help') {
      out.help = true;
    } else {
      bad(`update: unknown flag '${f}'`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Implement `run-update.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {UpdateArgs} from '../args.js';
import type {Exec} from '../exec.js';
import type {Finding} from './migration.js';
import {selectMigrations} from './migration.js';
import {MIGRATIONS} from './migrations/index.js';
import {detectAppPackageManager, installCommand} from './package-manager.js';
import {createLazyProject} from './project.js';
import {
  bumpRanges,
  compareVersions,
  resolveFromVersion,
  scanAgentbackRanges,
  type PackageJson,
} from './versions.js';

export interface UpdateDeps {
  exec: Exec;
  cwd: string;
  selfVersion: string;
}

export interface UpdateReport {
  from: string;
  to: string;
  changed: string[];
  disagreement: string[];
  findings: Array<Finding & {migration: string}>;
  installed: boolean;
  dryRun: boolean;
}

async function assertCleanTree(exec: Exec, cwd: string): Promise<void> {
  const r = await exec('git', ['-C', cwd, 'status', '--porcelain']);
  // Not a git repo (or git missing) — nothing to protect, so allow it.
  if (r.code !== 0) return;
  if (r.stdout.trim() === '') return;
  throw new AgentError(
    'update: the working tree has uncommitted changes. Commit or stash first ' +
      'so you can undo this update with git, or re-run with --force.',
    {code: ErrorCodes.INVALID_INPUT},
  );
}

export async function runUpdate(
  args: UpdateArgs,
  deps: UpdateDeps,
): Promise<UpdateReport> {
  const {cwd, exec, selfVersion} = deps;
  const to = args.to ?? selfVersion;

  // Lockstep versioning means the CLI installed in a 0.9 app cannot contain
  // the 0.9 -> 0.10 migration; that entry only exists in the 0.10 release.
  if (compareVersions(selfVersion, to) < 0) {
    throw new AgentError(
      `update: this CLI is ${selfVersion} and cannot migrate to ${to} — the ` +
        'migrations for that release ship with it. Run ' +
        '`npx @agentback/cli@latest update` instead.',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }

  if (!args.dryRun && !args.force) await assertCleanTree(exec, cwd);

  // --- Phase 1: resolve -------------------------------------------------
  const pkgPath = path.join(cwd, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
  const {version: from, disagreement} = resolveFromVersion(
    scanAgentbackRanges(pkg),
  );

  // --- Phase 2: bump ----------------------------------------------------
  const {pkg: bumped, changed} = bumpRanges(pkg, to);
  let installed = false;
  if (!args.dryRun && changed.length) {
    writeFileSync(pkgPath, JSON.stringify(bumped, null, 2) + '\n');
    const {cmd, args: iargs} = installCommand(detectAppPackageManager(cwd));
    const r = await exec(cmd, iargs);
    if (r.code !== 0)
      throw new AgentError(
        `update: \`${cmd} ${iargs.join(' ')}\` failed with code ${r.code}. ` +
          'package.json has been bumped; re-run install manually.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    installed = true;
  }

  // --- Phase 3: migrate -------------------------------------------------
  const findings: Array<Finding & {migration: string}> = [];
  const ctx = {
    root: cwd,
    pkg: bumped,
    project: createLazyProject(cwd),
    from,
    to,
  };
  for (const m of selectMigrations(MIGRATIONS, from, to)) {
    for (const f of m.detect(ctx)) findings.push({...f, migration: m.id});
    if (m.apply && !args.dryRun) m.apply(ctx);
  }

  return {from, to, changed, disagreement, findings, installed, dryRun: args.dryRun};
}

/** Render a report for the terminal. Returns the process exit code. */
export function printUpdateReport(r: UpdateReport): number {
  if (r.dryRun) console.log('Dry run — nothing was written.\n');
  console.log(`${r.from} → ${r.to}`);

  if (r.disagreement.length)
    console.log(
      `\nWarning: @agentback/* versions disagreed (${r.disagreement.join(', ')}). ` +
        `Used the lowest (${r.from}) so no migration is skipped.`,
    );

  console.log(
    r.changed.length
      ? `\nBumped ${r.changed.length} dependencies:\n  ${r.changed.join('\n  ')}`
      : '\nNo dependency ranges needed changing.',
  );

  if (!r.findings.length) {
    console.log('\nNo migration notes for this range.');
    return 0;
  }

  console.log(`\n${r.findings.length} migration note(s):`);
  for (const f of r.findings) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(app)';
    console.log(`\n  [${f.migration}] ${where}`);
    console.log(`    ${f.message}`);
    console.log(`    → ${f.action}`);
  }
  return 0;
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/
```

Expected: PASS across every unit file.

- [ ] **Step 6: Route `update` in `cli.ts`**

Add to `main`'s switch, before the fallthrough:

```ts
    if (cmd === 'update') {
      const args = parseUpdateArgs(rest);
      if (args.help) {
        console.log(UPDATE_USAGE);
        return 0;
      }
      const report = await runUpdate(args, {
        exec: nodeExec,
        cwd: process.cwd(),
        selfVersion: selfVersion(),
      });
      return printUpdateReport(report);
    }
```

Define `UPDATE_USAGE` next to `USAGE`:

```ts
const UPDATE_USAGE = `agentback update — upgrade an app across an AgentBack release

Usage:
  agentback update [--to <version>] [--dry-run] [--force]

Options:
  --to <version>   exact target version (default: this CLI's version)
  --dry-run        report findings and the intended bump; write nothing
  --force          proceed even if the git working tree is dirty
  -h, --help       show this help

Because releases are lockstep, the migrations for a release ship with it —
run \`npx @agentback/cli@latest update\` to migrate to the newest version.
`;
```

Add the imports for `parseUpdateArgs`, `runUpdate`, `printUpdateReport`, and `selfVersion`.

- [ ] **Step 7: Verify the whole package**

```bash
pnpm build && pnpm exec vitest run packages/cli/dist/__tests__/
```

Expected: PASS across unit, integration, and e2e.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/update/run-update.ts packages/cli/src/args.ts \
  packages/cli/src/cli.ts packages/cli/src/__tests__/unit/update-run.unit.ts \
  packages/cli/src/__tests__/unit/args.unit.ts
git commit -m "feat(cli): agentback update — resolve, bump, migrate, report"
```

---

### Task 8: Documentation surfaces

**Files:**
- Create: `skills/agentback/references/cli.md`
- Modify: `packages/cli/README.md`, `skills/agentback/SKILL.md`, `docs/packages.md`, `CLAUDE.md`, `docs/proposals/cli-lifecycle.md` (status)

> These are spec acceptance criteria, not optional polish. CLAUDE.md's doc checklist already missed this exact surface once — the `create-agentback` capability work shipped and the skill was never updated.

- [ ] **Step 1: Fix the stale scaffolder section in `SKILL.md`**

`skills/agentback/SKILL.md:69–104` documents only the three templates. It must also cover, with the same "`--` matters with npm" warning already there:

- `--with <caps>` plus the `--drizzle` / `--auth` / `-c|--console` shorthands, with the capability list (`console`, `drizzle`, `auth`)
- `--port` / `--host` / `--base-path`
- `-i|--interactive`, and that running with no name on a TTY is interactive
- The corrected programmatic signature — it currently says `{name, template?, cwd?, version?}`; the real `ScaffoldOptions` (`packages/create-agentback/src/scaffold.ts:26`) also has `console?`, `host?: {port?, host?, basePath?}`, and `capabilities?: string[]`

- [ ] **Step 2: Add the routing-table row in `SKILL.md`**

The routing list ends at item 11 (operator CLI). Add:

```markdown
12. **Upgrade an app across a breaking AgentBack release, or scaffold/deploy
    from one binary?** → Lifecycle CLI ([cli.md](references/cli.md))
```

- [ ] **Step 3: Write `skills/agentback/references/cli.md`**

`deploy` has no reference page today — only prose at `composition-and-operations.md:493`. The new page covers all three subcommands: `new` (flags, capability list, relationship to `npm create agentback`), `deploy` (both targets, `--eject`, `--dry-run`, `--temporary`, `--console`, `--verify-path`), and `update` (the three phases, `--to`/`--dry-run`/`--force`, why `npx @agentback/cli@latest` is the normal invocation, and that advisories report things it cannot fix). Open with the same disambiguation the spec uses: this is the ops CLI, not `@agentback/command`.

- [ ] **Step 4: Update the remaining surfaces**

- `packages/cli/README.md` — all three subcommands, replacing the deploy-only framing
- `docs/packages.md` — the `@agentback/cli` row becomes lifecycle scope
- `CLAUDE.md` — the `@agentback/cli` mention in the capability list; note `create-agentback` and `ts-morph` are now real deps
- `docs/proposals/cli-lifecycle.md` — flip **Status** from `Design` to `SHIPPED (<date>)` and tick the acceptance-criteria checkboxes

- [ ] **Step 5: Regenerate `AGENTS.md`**

```bash
pnpm agents-md && node scripts/gen-agents-md.mjs --check
```

Expected: the check passes. `AGENTS.md` is gitignored — do not stage it.

- [ ] **Step 6: Full verification**

```bash
pnpm verify
```

Expected: PASS — konsistent, build, typecheck:client, test, validate-templates, build:site. `build:site` is the one that catches a broken repo-relative link in the new docs.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/README.md skills/agentback/SKILL.md \
  skills/agentback/references/cli.md docs/packages.md CLAUDE.md \
  docs/proposals/cli-lifecycle.md
git commit -m "docs(cli): lifecycle CLI reference and the stale create-agentback skill fix"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: topology → 1; `new` delegate → 1; reuse table → 1, 3, 7; three phases → 2, 3, 7; migration registry → 4, 6; ts-morph engine → 5; safety (git guard, dry-run) → 7; seed registry → 6; testing → every task's TDD cycle plus 5's fidelity guard; build wiring → 1; doc surfaces → 8.

**Two deliberate deviations from the spec**, both corrections rather than omissions:

1. The spec says `update` reuses `detectPackageManager` from `create-agentback`. It cannot — that function reads `npm_config_user_agent`, the invoking manager, which is always npm under `npx`. Task 3 adds lockfile-based detection instead.
2. `MigrationContext.project()` gained an `onBuild` test seam so laziness is assertable.

**Known gaps, stated rather than hidden:**

- The advisory detectors are regex-and-AST heuristics over source text. They will miss config supplied indirectly (a spread options object, a value imported from another module). That is acceptable for advisories — they are hints, not gates — but it must not be mistaken for a guarantee, and Task 6's negative cases are what keep the false-positive rate honest.
- `@agentback/openapi` remains a `devDependency` of `@agentback/cli` while being imported at runtime (`package.json:26`, `args.ts:5`). Pre-existing; untouched here because fixing it is a packaging change unrelated to this feature.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-04-cli-lifecycle.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.
