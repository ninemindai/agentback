# CLI Lifecycle (`agentback new` / `deploy` / `update`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@agentback/cli` from a deploy-only binary into the lifecycle binary — `agentback new` (delegating to `create-agentback`), unchanged `deploy`, and a new `update` that bumps lockstep `@agentback/*` ranges then runs a codemod-or-advisory migration registry.

**Architecture:** `cli.ts` becomes a plain subcommand switch. `new` calls `create-agentback`'s exported `scaffold()` in-process. `update` is a three-phase pipeline (resolve → **migrate** → bump+install) in `packages/cli/src/update/`, where migrations share one interface and an advisory is simply a migration with no `apply`. **Subprocess** I/O flows through the existing injected `Exec` seam so tests never spawn a package manager; filesystem reads and writes are direct, against `mkdtemp` trees in tests.

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
| `packages/cli/src/update/migrations/helpers.ts` | Shared ts-morph queries (`installMcpHttpCalls`, `rel`) — owned by no single migration |
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
| `packages/cli/package.json` | Add `create-agentback`, `ts-morph`, `semver` to `dependencies`; **move `@agentback/openapi` out of `devDependencies`** |
| `packages/create-agentback/templates/*/{package.json,README.md}` | Add an `update` script + "Upgrading" section — otherwise `update` is undiscoverable |
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

In `packages/cli/package.json`, add to `dependencies` (keep keys sorted) — and **move `@agentback/openapi` out of `devDependencies`**:

```json
  "dependencies": {
    "@agentback/openapi": "workspace:~",
    "create-agentback": "workspace:~",
    "esbuild": "~0.28.1",
    "semver": "^7.7.0",
    "smol-toml": "^1.7.0",
    "ts-morph": "^28.0.0"
  },
```

> **The `@agentback/openapi` move is a P0, not tidying.** It is a `devDependency`
> today (`package.json:26`) while `args.ts:5` and `cli.ts` import `AgentError`
> from it **at runtime**. `npx` installs `dependencies` only — so
> `npx @agentback/cli@latest update`, which lockstep versioning makes the
> *primary* invocation for this whole feature, would crash on import. Deploy has
> the same latent bug today; this change fixes both.
>
> `ts-morph` and `semver` land here too (not in Task 5) so every task boundary
> stays commit-safe — Task 4's `migration.ts` type-imports `ts-morph`, and a task
> that cannot build on its own is not a task.

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
    } else if (NEW_VALUE_FLAGS.has(f) || EQ_FORM.test(f)) {
      // `--template rest` and `--template=rest` must both work: the `=` form is
      // supported by `create-agentback`'s own CLI, and two entry points to the
      // same scaffolder disagreeing on flag syntax is a bug users hit once and
      // never forgive.
      const eq = f.indexOf('=');
      const flag = eq === -1 ? f : f.slice(0, eq);
      const v = eq === -1 ? argv[++i] : f.slice(eq + 1);
      if (v === undefined || v === '') bad(`new: ${flag} needs a value`);
      if (flag === '--template' || flag === '-t') {
        if (!(TEMPLATES as readonly string[]).includes(v))
          bad(`new: unknown template '${v}' (supported: ${TEMPLATES.join(', ')})`);
        out.template = v as TemplateName;
      } else if (flag === '--with') {
        for (const c of v.split(',').filter(Boolean)) caps.add(c);
      } else if (flag === '--port') {
        const n = Number(v);
        if (!Number.isInteger(n)) bad(`new: --port must be an integer, got '${v}'`);
        host.port = n;
      } else if (flag === '--host') {
        host.host = v;
      } else if (flag === '--base-path') {
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

  // Validate capabilities HERE, not in scaffold(). A typo should fail at the
  // flag that carried it, naming the valid set — not deep inside a copy step.
  for (const c of caps) {
    if (!capabilityNames().includes(c))
      bad(`new: unknown capability '${c}' (supported: ${capabilityNames().join(', ')})`);
  }
  out.capabilities = [...caps]; // a Set, so `--with drizzle --drizzle` is one

  if (!out.name && !out.help)
    bad(
      'new: missing name. Usage: agentback new <name> [--template hybrid|rest|mcp]\n' +
        'For the interactive wizard, run: npm create agentback',
    );
  if (Object.keys(host).length) out.host = host;
  return out;
}
```

Declare `const caps = new Set<string>();` alongside `host`, and `const EQ_FORM = /^--[a-z-]+=/;` next to `NEW_VALUE_FLAGS`. Add to the imports at the top of `args.ts`:

```ts
import {TEMPLATES, capabilityNames, type TemplateName} from 'create-agentback';
```

> **`agentback new` is deliberately non-interactive.** `create-agentback` prompts
> when run with no name on a TTY; this delegate errors and points at
> `npm create agentback` instead. Two entry points that behave differently on the
> same input is exactly the inconsistency to avoid, so the difference is stated in
> the error itself and must be stated in Task 8's docs. Do not silently inherit
> the prompt behaviour without adding `-i` here too.

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
(also available as \`abc\`)

Usage:
  agentback new <name> [--template hybrid|rest|mcp] [--with <caps>]
  agentback deploy (vercel|cloudflare) [options]
  agentback update [--to <version>] [--dry-run] [--force]
  agentback --version

Run \`agentback <command> --help\` for command-specific options.

Exit codes: 0 success (migration notes are advisory and do NOT change this),
1 failure. Nothing to gate CI on yet — ask if you need one.
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    // `--version` is table stakes for any CLI, and load-bearing for this one:
    // `update` refuses when the CLI is older than the target and tells the user
    // to compare versions, which is unanswerable without this.
    if (cmd === '--version' || cmd === '-v') {
      console.log(selfVersion());
      return 0;
    }
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
  it('collects @agentback/* across dep sections, keyed by section', () => {
    const r = scanAgentbackRanges(PKG);
    expect([...r.keys()].sort()).toEqual([
      'dependencies:@agentback/core',
      'dependencies:@agentback/rest',
      'devDependencies:@agentback/testing',
    ]);
  });

  it('keeps both entries when one package is in two sections', () => {
    const r = scanAgentbackRanges({
      dependencies: {'@agentback/core': '^0.9.0'},
      devDependencies: {'@agentback/core': '^0.8.0'},
    });
    expect(r.size).toBe(2);
    expect(resolveFromVersion(r).disagreement).toHaveLength(2);
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
      unparsed: [],
    });
  });

  it('reports disagreement and picks the lowest', () => {
    const r = resolveFromVersion(
      new Map([
        ['dependencies:@agentback/core', '^0.9.0'],
        ['dependencies:@agentback/rest', '^0.8.0'],
      ]),
    );
    expect(r.version).toBe('0.8.0');
    expect(r.disagreement).toHaveLength(2);
  });

  it('records unparseable ranges instead of dropping them', () => {
    const r = resolveFromVersion(
      new Map([
        ['dependencies:@agentback/core', '^0.9.0'],
        ['dependencies:@agentback/rest', 'latest'],
      ]),
    );
    expect(r.version).toBe('0.9.0');
    expect(r.unparsed).toEqual(['dependencies:@agentback/rest']);
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

  it('reports but does not rewrite an unparseable range', () => {
    const pkg = {dependencies: {'@agentback/core': 'latest'}};
    const {pkg: out, changed, skipped} = bumpRanges(pkg, '0.10.0');
    expect(out.dependencies!['@agentback/core']).toBe('latest');
    expect(changed).toEqual([]);
    expect(skipped).toEqual(['dependencies:@agentback/core']);
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.9.1', '0.9.1')).toBe(0);
  });

  it('orders a prerelease below its release (the hand parser could not)', () => {
    expect(compareVersions('0.10.0-rc.1', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0-rc.2', '0.10.0-rc.1')).toBeGreaterThan(0);
  });
});

describe('detectIndent', () => {
  it('detects 2-space, 4-space, and tab indentation', () => {
    expect(detectIndent('{\n  "a": 1\n}\n')).toBe(2);
    expect(detectIndent('{\n    "a": 1\n}\n')).toBe(4);
    expect(detectIndent('{\n\t"a": 1\n}\n')).toBe('\t');
  });

  it('defaults to 2 for a single-line file', () => {
    expect(detectIndent('{"a":1}')).toBe(2);
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
import semver from 'semver';
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

/**
 * Collect every `@agentback/*` range across all dependency sections.
 *
 * Keyed `<section>:<name>`, NOT by name alone: the same package can appear in
 * both `dependencies` and `devDependencies` with different ranges, and a
 * name-keyed map would let the second silently overwrite the first — hiding
 * exactly the version disagreement `resolveFromVersion` exists to report.
 */
export function scanAgentbackRanges(pkg: PackageJson): Map<string, string> {
  const out = new Map<string, string>();
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      // `workspace:` entries are in-repo and are pnpm's problem, not ours.
      if (!name.startsWith('@agentback/')) continue;
      if (range.startsWith('workspace:')) continue;
      out.set(`${section}:${name}`, range);
    }
  }
  return out;
}

/**
 * Version comparison via `semver`, not a hand parser. A hand-rolled
 * `split('.').map(Number)` silently mis-sorts prereleases (`0.10.0-rc.1`) and
 * build metadata, and a lockstep 0.x project cutting an rc is not exotic.
 */
export function compareVersions(a: string, b: string): number {
  return semver.compare(a, b);
}

/**
 * Derive the app's current version from its `@agentback/*` ranges. Lockstep
 * releases mean they agree; disagreement is reported (not fatal) and the
 * LOWEST version wins, so every migration in between still runs.
 */
export function resolveFromVersion(ranges: Map<string, string>): {
  version: string;
  disagreement: string[];
  unparsed: string[];
} {
  const parsed = new Map<string, string>();
  const unparsed: string[] = [];
  for (const [key, range] of ranges) {
    const m = RANGE_RE.exec(range);
    // `latest`, a dist-tag, `npm:` alias, or a compound range. Recorded, never
    // silently dropped: `bumpRanges` must not rewrite what this could not read.
    if (m) parsed.set(key, m[1]);
    else unparsed.push(key);
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
    unparsed,
  };
}

/**
 * Rewrite every `@agentback/*` range to `^<to>`. Mutates and returns `pkg`.
 *
 * Skips anything `resolveFromVersion` could not parse. The asymmetry matters:
 * if resolve ignores `"@agentback/core": "latest"` when deriving `from`, bump
 * must not then rewrite it to `^0.10.0` — that mutates a dependency whose
 * intent the tool admitted it did not understand. Reported, not touched.
 */
export function bumpRanges(
  pkg: PackageJson,
  to: string,
): {pkg: PackageJson; changed: string[]; skipped: string[]} {
  const changed: string[] = [];
  const skipped: string[] = [];
  const next = `^${to}`;
  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@agentback/')) continue;
      if (deps[name].startsWith('workspace:')) continue;
      if (!RANGE_RE.test(deps[name])) {
        skipped.push(`${section}:${name}`);
        continue;
      }
      if (deps[name] === next) continue;
      deps[name] = next;
      changed.push(name);
    }
  }
  return {pkg, changed, skipped};
}

/** Detect a JSON file's indentation so a rewrite preserves it. */
export function detectIndent(source: string): string | number {
  const m = /^[ \t]+/m.exec(source.replace(/^\{[^\n]*\n/, ''));
  if (!m) return 2;
  return m[0].startsWith('\t') ? '\t' : m[0].length;
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

  it('lets the Corepack packageManager field beat the lockfile', () => {
    writeFileSync(path.join(root, 'package-lock.json'), '');
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({packageManager: 'pnpm@11.2.0'}),
    );
    expect(detectAppPackageManager(root)).toBe('pnpm');
  });

  it('falls back to the lockfile when packageManager names an unknown tool', () => {
    writeFileSync(path.join(root, 'yarn.lock'), '');
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({packageManager: 'nx@1.0.0'}),
    );
    expect(detectAppPackageManager(root)).toBe('yarn');
  });

  it('survives a malformed package.json', () => {
    writeFileSync(path.join(root, 'package.json'), '{not json');
    writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
    expect(detectAppPackageManager(root)).toBe('pnpm');
  });
});

describe('installCommand', () => {
  it('maps each manager to its install invocation', () => {
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    for (const pm of ['pnpm', 'yarn', 'bun', 'npm'] as const) {
      expect(installCommand(pm)).toEqual({
        cmd: `${pm}${suffix}`,
        args: ['install'],
      });
    }
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

import {existsSync, readFileSync} from 'node:fs';
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
 * Detect the app's package manager. Deliberately NOT `create-agentback`'s
 * `detectPackageManager()` — that reads the invoking manager from npm's
 * user-agent, which is always npm under `npx`.
 *
 * `packageManager` wins over lockfiles: it is Corepack's declared source of
 * truth, so it states intent, while a lockfile is a side effect that can be
 * stale or checked in by accident.
 */
export function detectAppPackageManager(root: string): PackageManager {
  const declared = readPackageManagerField(root);
  if (declared) return declared;
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(path.join(root, file))) return pm;
  }
  return 'npm';
}

/** Read the Corepack `packageManager` field, e.g. `"pnpm@11.2.0"`. */
function readPackageManagerField(root: string): PackageManager | undefined {
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  let field: unknown;
  try {
    field = (JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      packageManager?: unknown;
    }).packageManager;
  } catch {
    return undefined; // malformed package.json is phase 1's problem, not ours
  }
  if (typeof field !== 'string') return undefined;
  const name = field.split('@')[0];
  return (['pnpm', 'yarn', 'bun', 'npm'] as const).find(p => p === name);
}

export function installCommand(pm: PackageManager): {
  cmd: string;
  args: string[];
} {
  // Windows package managers are `.cmd` shims, and `spawn()` without `shell`
  // cannot execute them — it fails ENOENT on a manager that is definitely
  // installed. `deploy` has the same latent issue, but `update` makes it hit
  // every Windows user on the primary path, so resolve the real name here.
  const cmd = process.platform === 'win32' ? `${pm}.cmd` : pm;
  return {cmd, args: ['install']};
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
  /** Parsed package.json, PRE-bump — migrations run before the bump lands. */
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
  /**
   * Present ⇒ codemod. Absent ⇒ advisory.
   *
   * WHEN YOU WRITE THE FIRST REAL ONE: rewriting declarations is not the whole
   * job. This repo's MCP v1→v2 codemod rewrote imports and class names but not
   * PROPERTY READS — `OAuthError.errorCode` → `.code` was missed, so the result
   * compiled cleanly and served `error="undefined"` at runtime. A codemod that
   * type-checks is not a codemod that is correct. Enumerate the property reads,
   * and pair every transform with a test asserting post-conditions on behaviour,
   * not just on shape.
   */
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

- [ ] **Step 1: Confirm the dependency is present**

`ts-morph` was added in Task 1 Step 1 so every task boundary stays commit-safe. Verify it resolves:

```bash
pnpm -F @agentback/cli exec node -e "import('ts-morph').then(m => console.log(typeof m.Project))"
```

Expected: `function`. If pnpm rejected the version at install with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, pin one patch older rather than adding a `minimumReleaseAgeExclude` entry.

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

  it('falls back to a glob when tsconfig extends an uninstalled package', () => {
    // The contract is "works on a tree that has never been installed", and
    // `extends` into node_modules cannot resolve before install.
    writeFileSync(
      path.join(root, 'tsconfig.json'),
      JSON.stringify({extends: '@tsconfig/node22/tsconfig.json'}),
    );
    const files = createLazyProject(root)().getSourceFiles();
    expect(files.map(f => path.basename(f.getFilePath()))).toContain('greet.ts');
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
    // A tsconfig that `extends` a package (@tsconfig/node22, a shared preset)
    // cannot resolve before `npm install`, and detection is contractually
    // required to work on a never-installed tree. Glob is the fallback: it
    // loses compiler options we do not use, and never throws.
    if (existsSync(tsconfig)) {
      try {
        project = new Project({tsConfigFilePath: tsconfig});
      } catch {
        project = undefined;
      }
    }
    if (!project) {
      project = new Project({skipAddingFilesFromTsConfig: true});
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

Create `packages/cli/src/update/migrations/helpers.ts` — shared queries live in their own file, **not** inside one migration. A helper exported from `mcp-stateless-default.ts` and imported by its two siblings means deleting that migration breaks the other two:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import path from 'node:path';
import {SyntaxKind, type CallExpression, type SourceFile} from 'ts-morph';
import type {MigrationContext} from '../migration.js';

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

/** App-relative path for a `Finding.file`. */
export function rel(ctx: MigrationContext, file: SourceFile): string {
  return path.relative(ctx.root, file.getFilePath());
}
```

Create `packages/cli/src/update/migrations/mcp-stateless-default.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Finding, Migration} from '../migration.js';
import {installMcpHttpCalls, rel} from './helpers.js';

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
import {rel} from './helpers.js';

export const mcpStatelessScopeHoles: Migration = {
  id: 'mcp-stateless-scope-holes',
  version: '0.9.0',
  title: 'Stateless scope filtering and confirmation-store lifetime',
  detect(ctx) {
    const findings: Finding[] = [];
    const files = ctx.project().getSourceFiles();
    const all = files.map(f => f.getFullText()).join('\n');

    // Guard before the loop: `optionalAuth` is computed across all files and
    // cannot change inside it.
    const optionalAuth = /required\s*:\s*false/.test(all);
    for (const file of optionalAuth ? files : []) {
      if (!/@tool\([^)]*scope\s*:/s.test(file.getFullText())) continue;
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
import {installMcpHttpCalls, rel} from './helpers.js';

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
import type {Migration} from '../../update/migration.js';
import {printUpdateReport, runUpdate} from '../../update/run-update.js';

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

  it('refuses a downgrade without --force', async () => {
    const {exec} = stubExec();
    await expect(
      runUpdate(
        {dryRun: false, force: false, help: false, to: '0.8.0'},
        {exec, cwd, selfVersion: '0.12.0'},
      ),
    ).rejects.toThrow(/older than the app's current/);
  });

  it('preserves the manifest indentation', async () => {
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify(PKG, null, 4) + '\n',
    );
    const {exec} = stubExec();
    await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    const after = readFileSync(path.join(cwd, 'package.json'), 'utf8');
    expect(after).toContain('\n    "name"');
    expect(after).not.toContain('\n  "name"');
  });

  it('warns instead of silently proceeding when the git guard cannot run', async () => {
    const exec: Exec = async cmd =>
      cmd === 'git'
        ? {code: 127, stdout: '', stderr: 'command not found'}
        : {code: 0, stdout: '', stderr: ''};
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.warnings.join(' ')).toMatch(/Could not verify the git working tree/);
  });
});

// The seam that joins resolve -> select -> detect -> report. Without this, the
// advisories are tested in isolation and runUpdate is tested with an empty
// migration window, so nothing proves the two halves connect.
describe('runUpdate phase 2 (migrations)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-mig-'));
    mkdirSync(path.join(cwd, 'src'));
    writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export class A {}\n');
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({...PKG, dependencies: {'@agentback/core': '^0.8.0'}}, null, 2) + '\n',
    );
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  const advisory: Migration = {
    id: 'fake-advisory',
    version: '0.9.0',
    title: 'fake',
    detect: () => [{message: 'found it', action: 'do the thing'}],
  };

  it('surfaces findings from a migration inside the window', async () => {
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0', migrations: [advisory]},
    );
    expect(r.findings).toEqual([
      {message: 'found it', action: 'do the thing', migration: 'fake-advisory'},
    ]);
  });

  it('runs apply() outside dry-run and skips it inside', async () => {
    const applied: string[] = [];
    const codemod: Migration = {
      ...advisory,
      id: 'fake-codemod',
      apply: () => applied.push('ran'),
    };
    const {exec} = stubExec();
    const opts = {force: false, help: false, to: '0.10.0'};

    await runUpdate({...opts, dryRun: true}, {
      exec, cwd, selfVersion: '0.10.0', migrations: [codemod],
    });
    expect(applied).toEqual([]);

    await runUpdate({...opts, dryRun: false}, {
      exec, cwd, selfVersion: '0.10.0', migrations: [codemod],
    });
    expect(applied).toEqual(['ran']);
  });

  it('leaves package.json un-bumped when a migration throws', async () => {
    const exploding: Migration = {
      ...advisory,
      id: 'boom',
      apply: () => {
        throw new Error('transform failed');
      },
    };
    const {exec} = stubExec();
    await expect(
      runUpdate({dryRun: false, force: false, help: false, to: '0.10.0'}, {
        exec, cwd, selfVersion: '0.10.0', migrations: [exploding],
      }),
    ).rejects.toThrow(/transform failed/);

    // The whole point of migrating before bumping: a failed run must not move
    // `from` forward, or the re-run silently skips the migration window.
    const pkg = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    ) as {dependencies: Record<string, string>};
    expect(pkg.dependencies['@agentback/core']).toBe('^0.8.0');
  });
});

describe('printUpdateReport', () => {
  const base = {
    from: '0.9.0', to: '0.10.0', changed: ['@agentback/core'], skipped: [],
    unparsed: [], disagreement: [], warnings: [], findings: [],
    installed: true, dryRun: false,
  };

  it('renders the version transition and the bump count', () => {
    const lines: string[] = [];
    expect(printUpdateReport(base, s => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toContain('0.9.0 → 0.10.0');
    expect(lines.join('\n')).toContain('Bumped 1 dependencies');
  });

  it('renders each finding with its migration id and action', () => {
    const lines: string[] = [];
    printUpdateReport(
      {...base, findings: [
        {migration: 'm1', file: 'src/a.ts', line: 7, message: 'msg', action: 'fix it'},
      ]},
      s => lines.push(s),
    );
    const text = lines.join('\n');
    expect(text).toContain('[m1] src/a.ts:7');
    expect(text).toContain('→ fix it');
  });

  it('surfaces skipped ranges so they are not silently left behind', () => {
    const lines: string[] = [];
    printUpdateReport(
      {...base, skipped: ['dependencies:@agentback/rest']},
      s => lines.push(s),
    );
    expect(lines.join('\n')).toContain('dependencies:@agentback/rest');
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
import type {Finding, Migration, MigrationContext} from './migration.js';
import {selectMigrations} from './migration.js';
import {MIGRATIONS} from './migrations/index.js';
import {detectAppPackageManager, installCommand} from './package-manager.js';
import {createLazyProject} from './project.js';
import {
  bumpRanges,
  compareVersions,
  detectIndent,
  resolveFromVersion,
  scanAgentbackRanges,
  type PackageJson,
} from './versions.js';

export interface UpdateDeps {
  exec: Exec;
  cwd: string;
  selfVersion: string;
  /**
   * Registry override. Defaults to the shipped `MIGRATIONS`. Injectable so a
   * fake migration can prove the `apply` seam — ordering, dry-run skip, and
   * failure handling — without waiting for a real codemod to exist.
   */
  migrations?: readonly Migration[];
}

export interface UpdateReport {
  from: string;
  to: string;
  changed: string[];
  /** `@agentback/*` entries whose range was too complex to read or rewrite. */
  skipped: string[];
  unparsed: string[];
  disagreement: string[];
  /** Non-fatal conditions the user must see (e.g. the git guard could not run). */
  warnings: string[];
  findings: Array<Finding & {migration: string}>;
  installed: boolean;
  dryRun: boolean;
}

/**
 * @returns a warning when the guard could not run. Git is the undo mechanism
 * for this command, so "we could not check" is a fact the user needs — not the
 * same thing as "there is nothing to protect". Silently treating every git
 * failure (missing binary, permission error, corrupt index) as safe is how a
 * safety guard becomes decorative.
 */
async function assertCleanTree(
  exec: Exec,
  cwd: string,
): Promise<string | undefined> {
  const r = await exec('git', ['-C', cwd, 'status', '--porcelain']);
  if (r.code !== 0) {
    return (
      'Could not verify the git working tree (git exited ' +
      `${r.code}). Proceeding without an undo checkpoint.`
    );
  }
  if (r.stdout.trim() === '') return undefined;
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

  const warnings: string[] = [];
  if (!args.dryRun && !args.force) {
    const w = await assertCleanTree(exec, cwd);
    if (w) warnings.push(w);
  }

  // --- Phase 1: resolve -------------------------------------------------
  const pkgPath = path.join(cwd, 'package.json');
  const source = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(source) as PackageJson;
  const {version: from, disagreement, unparsed} = resolveFromVersion(
    scanAgentbackRanges(pkg),
  );

  // A command named `update` must not quietly walk an app backwards. Migration
  // direction is undefined going down, and `(from, to]` selects nothing — so a
  // downgrade would report "no migration notes" and look like it worked.
  if (compareVersions(to, from) < 0 && !args.force) {
    throw new AgentError(
      `update: ${to} is older than the app's current ${from}. Re-run with ` +
        '--force to downgrade; no migrations run in that direction.',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }

  // --- Phase 2: migrate (BEFORE the bump — see below) -------------------
  //
  // Ordering is load-bearing, not stylistic. If the bump+install ran first and
  // install failed, package.json would already say `to` — so the next run
  // resolves `from` as the NEW version, computes an empty (from, to] window,
  // and silently skips every migration forever. Migrating first makes a failed
  // install harmless: package.json still says `from`, so a re-run repeats the
  // same (already-idempotent) detection and then retries the bump.
  const findings: Array<Finding & {migration: string}> = [];
  const ctx: MigrationContext = {
    root: cwd,
    pkg,
    project: createLazyProject(cwd),
    from,
    to,
  };
  for (const m of selectMigrations(deps.migrations ?? MIGRATIONS, from, to)) {
    for (const f of m.detect(ctx)) findings.push({...f, migration: m.id});
    if (m.apply && !args.dryRun) m.apply(ctx);
  }

  // --- Phase 3: bump + install ------------------------------------------
  const {pkg: bumped, changed, skipped} = bumpRanges(pkg, to);
  let installed = false;
  if (!args.dryRun && changed.length) {
    // Preserve the file's own indentation. Task 5 guards source formatting on
    // the grounds that scaffolded apps ship no prettier; a manifest rewritten
    // from 4-space to 2-space is the same damage from the same cause.
    writeFileSync(pkgPath, JSON.stringify(bumped, null, detectIndent(source)) + '\n');
    const {cmd, args: iargs} = installCommand(detectAppPackageManager(cwd));
    const r = await exec(cmd, iargs);
    if (r.code !== 0)
      throw new AgentError(
        `update: \`${cmd} ${iargs.join(' ')}\` failed with code ${r.code}. ` +
          'package.json has been bumped and migrations already ran; re-run ' +
          'install manually.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    installed = true;
  }

  return {
    from,
    to,
    changed,
    skipped,
    unparsed,
    disagreement,
    warnings,
    findings,
    installed,
    dryRun: args.dryRun,
  };
}

/**
 * Render a report for the terminal. Returns the process exit code.
 *
 * `console.log`, not `loggers()`: AgentBack's loggers are debug-namespaced, so
 * `log.warn` emits nothing unless `DEBUG` matches. A CLI's primary output must
 * not depend on an env var being set.
 */
export function printUpdateReport(
  r: UpdateReport,
  out: (s: string) => void = console.log,
): number {
  if (r.dryRun) out('Dry run — nothing was written.\n');
  out(`${r.from} → ${r.to}`);

  for (const w of r.warnings) out(`\nWarning: ${w}`);

  if (r.disagreement.length)
    out(
      `\nWarning: @agentback/* versions disagreed (${r.disagreement.join(', ')}). ` +
        `Used the lowest (${r.from}) so no migration is skipped.`,
    );

  if (r.skipped.length)
    out(
      `\nLeft alone (range too complex to rewrite safely):\n  ${r.skipped.join('\n  ')}` +
        '\n  Update these by hand.',
    );

  out(
    r.changed.length
      ? `\nBumped ${r.changed.length} dependencies:\n  ${r.changed.join('\n  ')}`
      : '\nNo dependency ranges needed changing.',
  );

  if (!r.findings.length) {
    out('\nNo migration notes for this range.');
    return 0;
  }

  out(`\n${r.findings.length} migration note(s):`);
  for (const f of r.findings) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(app)';
    out(`\n  [${f.migration}] ${where}`);
    out(`    ${f.message}`);
    out(`    → ${f.action}`);
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

- [ ] **Step 4: Close the discovery gap in the scaffolded app (DX review finding)**

A user who runs `npm create agentback` today has **no way to learn `update` exists**. The template's `package.json` scripts are `build`/`start`/`test`/`clean`, and its README covers install → build → start. Nothing mentions upgrading, so the feature is invisible to exactly the people it is for.

In `packages/create-agentback/templates/{hybrid,rest,mcp}/package.json`, add:

```json
    "update": "npx @agentback/cli@latest update"
```

`npx @agentback/cli@latest`, not a local dep — lockstep versioning means the installed CLI can never contain the migrations for the version it is upgrading *to*.

In each template README, add a short "Upgrading" section after the build/start steps:

```markdown
## Upgrading

    npm run update -- --dry-run   # report what changes, write nothing
    npm run update                # bump @agentback/* and run migrations
```

Update `validate-templates` expectations if it asserts on the script list.

- [ ] **Step 5: Update the remaining surfaces**

- `packages/cli/README.md` — all three subcommands, replacing the deploy-only framing
- `docs/packages.md` — the `@agentback/cli` row becomes lifecycle scope
- `CLAUDE.md` — the `@agentback/cli` mention in the capability list; note `create-agentback` and `ts-morph` are now real deps
- `docs/proposals/cli-lifecycle.md` — flip **Status** from `Design` to `SHIPPED (<date>)` and tick the acceptance-criteria checkboxes

- [ ] **Step 6: Regenerate `AGENTS.md`**

```bash
pnpm agents-md && node scripts/gen-agents-md.mjs --check
```

Expected: the check passes. `AGENTS.md` is gitignored — do not stage it.

- [ ] **Step 7: Full verification**

```bash
pnpm verify
```

Expected: PASS — konsistent, build, typecheck:client, test, validate-templates, build:site. `build:site` is the one that catches a broken repo-relative link in the new docs.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/README.md packages/create-agentback/templates/ skills/agentback/SKILL.md \
  skills/agentback/references/cli.md docs/packages.md CLAUDE.md \
  docs/proposals/cli-lifecycle.md
git commit -m "docs(cli): lifecycle CLI reference and the stale create-agentback skill fix"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: topology → 1; `new` delegate → 1; reuse table → 1, 3, 7; three phases → 2, 3, 7; migration registry → 4, 6; ts-morph engine → 5; safety (git guard, dry-run) → 7; seed registry → 6; testing → every task's TDD cycle plus 5's fidelity guard; build wiring → 1; doc surfaces → 8.

**Deliberate deviations from the spec**, all corrections rather than omissions:

1. The spec says `update` reuses `detectPackageManager` from `create-agentback`. It cannot — that function reads `npm_config_user_agent`, the invoking manager, which is always npm under `npx`. Task 3 detects from the Corepack `packageManager` field, falling back to the lockfile.
2. `MigrationContext.project()` gained an `onBuild` test seam so laziness is assertable.
3. The spec's phase order (resolve → bump → migrate) is **wrong** and is corrected to resolve → migrate → bump. See the comment in `runUpdate`: bumping first lets a failed install permanently skip the migration window.
4. `MigrationContext.pkg` is pre-bump, not post-bump, as a consequence of (3).
5. Version comparison uses `semver` rather than a hand parser, which mis-sorts prereleases.

**Known gaps, stated rather than hidden:**

- The advisory detectors are regex-and-AST heuristics over source text. They will miss config supplied indirectly (a spread options object, a value imported from another module). That is acceptable for advisories — they are hints, not gates — but it must not be mistaken for a guarantee, and Task 6's negative cases are what keep the false-positive rate honest.
- **Workspace apps are out of scope for v1.** `update` reads and writes the `package.json` at `cwd` only. An AgentBack app living in `packages/*` of a user monorepo needs `update` run from that package's directory. `workspace:` ranges are skipped by design (pnpm owns them). Not silently broken — but not solved either, and the docs in Task 8 must say so.
- **`--force` now overloads two meanings**: proceed on a dirty git tree, and permit a downgrade. Acceptable for v1 because both are "I know what I'm doing" escapes, but if a third meaning appears, split the flag.

**Post-review changes.** This plan was revised after `/plan-eng-review` (19 findings from the review plus the Codex outside voice). The load-bearing ones: phase order flipped to migrate-before-bump so a failed install cannot poison the migration window; `@agentback/openapi` promoted from `devDependency` (it is imported at runtime and `npx` — the primary invocation — installs `dependencies` only); `ts-morph`/`semver` moved into Task 1 so every task boundary is commit-safe; `MIGRATIONS` made injectable so the `apply` seam is testable at all.

---

## NOT in scope

Considered during review and explicitly deferred:

| Deferred | Why |
|---|---|
| `agentback add <capability>` | Its own spec. The hard part (anchor durability in an edited `application.ts`) is unrelated to `update`. |
| `agentback generate` | Declined, not deferred — a second source of truth for boilerplate whose only consumer is the coding agent. |
| Workspace/monorepo apps | `update` operates on `cwd` only. Run it from the app's directory. Documented, not solved. |
| Retroactive codemods | No published version ever shipped the old APIs (verified: both source-mechanical commits are not ancestors of `main`). |
| `CHANGELOG.md` | The migration registry is the machine-readable equivalent; prose can be generated from it later. |
| `update` running `pnpm build` afterward | Couples a fast command to a working toolchain. Revisit when a real codemod exists. |
| An `update` e2e over `packages/cli/fixtures/cf-app` | Unit + integration cover the logic; a second fixture app is maintenance weight for an untested payoff. |

## Failure modes

| Codepath | Realistic production failure | Test? | Handled? | Silent? |
|---|---|---|---|---|
| Phase 3 install | Registry 404s the just-published version (propagation lag) | ✅ non-zero exit asserted | ✅ `AgentError` naming the retry | No |
| Phase 3 install fails after bump | Migration window skipped on re-run | ✅ `leaves package.json un-bumped` | ✅ order fixed | No |
| `npx` invocation | `@agentback/openapi` missing → crash on import | — build-level | ✅ promoted to `dependencies` | **was silent** |
| Codemod `apply` throws mid-file | Partially transformed source | ✅ throw propagates, bump skipped | ✅ git is the undo | No |
| `createLazyProject` on uninstalled tree | tsconfig `extends` unresolvable | ✅ glob-fallback test | ✅ falls back | No |
| Git guard unavailable | No undo checkpoint | ✅ warning asserted | ✅ warns | **was silent** |

**Zero critical gaps remain.** Two were silent-failure-with-no-handling before this review (rows 3 and 6); both now warn or are structurally fixed.

## Parallelization

Sequential implementation, no parallelization opportunity — Tasks 2–7 all land in `packages/cli/src/update/` and Task 7 consumes every prior task's exports. Task 1 is independent but shares `args.ts` and `cli.ts` with Task 7, so a separate worktree would conflict on both.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-04-cli-lifecycle.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 25 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAR | score: 6/10 → 8/10, TTHW: 1 min (Champion) |
| Outside Voice | `/plan-eng-review` | Cross-model plan challenge | 1 | ISSUES_FOUND (codex) | 22 raised, 19 real, 3 rejected with evidence |

- **CODEX:** 19 of 22 findings accepted and folded. Three rejected against source: `agentback vercel` aliases do not exist (`cli.ts:38`); `scaffold()` is synchronous and returns `{dir}` (`scaffold.ts:148`, `:54`); `skills/agentback/*` is a required repo doc surface per `CLAUDE.md`, not agent-system coupling.
- **CROSS-MODEL:** Independent agreement on two findings — `package.json` reformatting and unguarded downgrades — both raised separately by the review and the outside voice, both fixed. One tension surfaced (ts-morph premature with zero codemods) and resolved by the user in favour of keeping it with the testability gap closed.
- **DX:** DX POLISH, persona = an AgentBack app author upgrading across a breaking alpha release. Four gaps fixed: no `agentback --version` (load-bearing, since `update` tells users to compare versions); `spawn()` of a bare `pnpm`/`npm` fails on Windows `.cmd` shims; the scaffolded app never mentioned `update` existed; the exit-code contract was undocumented. Measurement scores 3/10 — accepted for an alpha, logged below.
- **VERDICT:** ENG + DX CLEARED — ready to implement. Three P0/P1 defects were caught and fixed before implementation: migrate-before-bump ordering, the `@agentback/openapi` runtime-dependency crash on the `npx` path, and the non-commit-safe Task 4 boundary.

NO UNRESOLVED DECISIONS
