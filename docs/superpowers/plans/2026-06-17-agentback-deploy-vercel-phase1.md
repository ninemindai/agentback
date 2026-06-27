# `agentback deploy vercel` (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a new `@agentback/cli` package whose `deploy vercel` command generates the proven `agentback-demo` Vercel setup (root `api/index.ts` + `vercel.json`), shells `vercel deploy`, and verifies the REST API is live.

**Architecture:** A thin, concrete (no abstraction) command. Pure functions do the work — arg parsing, entry generation, order-aware `vercel.json` merge, builder resolution, verify — each unit-tested. The two effectful seams (shell-out, HTTP) are injected so the pipeline is testable without Vercel credentials. Files are written at repo root because Vercel discovers functions/config there.

**Tech Stack:** TypeScript 6.0 (ESM, `.js` import extensions), Node ≥22.13, pnpm 11 workspace, vitest (tests run against built `dist/`), `@clack/prompts`.

## Global Constraints

- **ESM-only**, `"type": "module"`, relative imports carry `.js` extensions. Node `>=22.13`.
- **Tests run against `dist/`**, not `src/`. Always `pnpm -F @agentback/cli build` before `pnpm -F @agentback/cli test`. Test files: `src/__tests__/unit/<name>.unit.ts`, compiled and globbed as `packages/*/dist/__tests__/**/*.unit.js`.
- **License header** on every source file (tooling-package style, matching `create-agentback`):
  ```ts
  // Copyright NineMind, Inc. 2026. All Rights Reserved.
  // This file is licensed under the MIT License.
  // License text available at https://opensource.org/license/mit/
  ```
- **Style:** single quotes, no bracket spacing (`{foo}`), trailing commas, 80 col, avoid arrow parens. `any` warns.
- **Bins:** `agentback` + `abc` → `dist/cli.js`. **Never** claim `ab` (ApacheBench).
- **Deployed surface default:** REST + `/openapi.json` only. Console is opt-in (`--console`) and gated by auth-or-`--unsafe-public-console`.
- **Files at repo root** (`api/index.ts`, `vercel.json`) — never a hidden ephemeral dir.
- **Generated handler types:** Node `IncomingMessage`/`ServerResponse`. **Never** import `@vercel/node`.
- **Errors:** throw `AgentError` from `@agentback/openapi` for user-facing failures (stable `code` + `message`), so the CLI prints a clean message, not a stack.

---

## File Structure

```
packages/cli/
  package.json            @agentback/cli, bins agentback+abc, dep @clack/prompts
  tsconfig.json           extends ../../tsconfig.base.json
  README.md
  src/
    cli.ts                #!/usr/bin/env node — entry, USAGE, dispatch, error→exit
    args.ts               parseDeployArgs(argv) → DeployArgs   (pure)
    detect.ts             resolveBuilder(), enforceConsoleGate(), inferPackageManager()
    generate-entry.ts     generateEntry(builder) → string      (pure)
    merge-config.ts       mergeVercelConfig(existing, opts)     (pure, order-aware)
    verify.ts             verifyDeploy(url, opts, fetchFn)
    run-vercel.ts         runVercelDeploy(args, deps) orchestrator; Exec/Fetch injected
    exec.ts               type Exec + nodeExec (child_process seam)
    __tests__/unit/
      args.unit.ts
      generate-entry.unit.ts
      merge-config.unit.ts
      detect.unit.ts
      verify.unit.ts
      run-vercel.unit.ts
    __tests__/e2e/
      deploy-vercel.e2e.ts   (opt-in, credential-gated)
```

Root `tsconfig.json` gains `{"path": "packages/cli"}` in `references`. `pnpm-workspace.yaml` already globs `packages/*`.

---

### Task 1: Package skeleton + bins

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/cli.ts`, `packages/cli/README.md`
- Modify: `tsconfig.json` (root, add reference)

**Interfaces:**
- Produces: the `agentback`/`abc` bin → `dist/cli.js`; an exported `main(argv: string[]): Promise<number>` returning a process exit code.

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@agentback/cli",
  "version": "0.0.1",
  "description": "AgentBack CLI: deploy an AgentBack app (agentback deploy vercel)",
  "type": "module",
  "bin": {
    "agentback": "dist/cli.js",
    "abc": "dist/cli.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "engines": {"node": ">=22.13"},
  "dependencies": {
    "@clack/prompts": "^0.11.0"
  },
  "devDependencies": {
    "@agentback/openapi": "workspace:~",
    "vitest": "~4.1.9"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ninemindai/agentback.git",
    "directory": "packages/cli"
  },
  "homepage": "https://agentback.dev",
  "bugs": "https://github.com/ninemindai/agentback/issues"
}
```

> Note: `@agentback/openapi` is used for `AgentError`. If a later task needs it at runtime (not just types), move it to `dependencies`.

- [ ] **Step 2: Create `packages/cli/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "./tsconfig.tsbuildinfo"
  },
  "references": [{"path": "../openapi"}],
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Add the root project reference**

In root `tsconfig.json`, add to the `references` array (after `packages/create-agentback`):

```json
    {"path": "packages/cli"},
```

- [ ] **Step 4: Create `packages/cli/src/cli.ts` (minimal, prints usage)**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

#!/usr/bin/env node
export const USAGE = `agentback — deploy an AgentBack app

Usage:
  agentback deploy vercel [options]

Run \`agentback deploy vercel --help\` for options.
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, target] = argv;
  if (cmd === 'deploy' && target === 'vercel') {
    // wired up in Task 8
    console.error('not yet implemented');
    return 1;
  }
  console.log(USAGE);
  return cmd ? 1 : 0;
}

// Bin entry: run main when invoked directly.
const invokedDirectly = process.argv[1]?.endsWith('cli.js');
if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
```

> The shebang must be the FIRST line of the emitted JS. TypeScript keeps a leading `#!` only if it is the first line of the source — place it above the license header in the emitted file by putting it first. If `tsc` reorders, move the license header below the shebang. Verify in Step 6.

- [ ] **Step 5: Install + build**

Run: `pnpm install && pnpm -F @agentback/cli build`
Expected: builds clean; `packages/cli/dist/cli.js` exists.

- [ ] **Step 6: Verify the bin runs and shebang is intact**

Run: `head -1 packages/cli/dist/cli.js && node packages/cli/dist/cli.js`
Expected: first line is `#!/usr/bin/env node`; output is the USAGE text; exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/cli tsconfig.json pnpm-lock.yaml
git commit -m "feat(cli): @agentback/cli package skeleton with agentback/abc bins"
```

---

### Task 2: Arg parser

**Files:**
- Create: `packages/cli/src/args.ts`, `packages/cli/src/__tests__/unit/args.unit.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DeployArgs {
    target: 'vercel';
    entry?: string;
    exportName?: string;
    name?: string;
    prod: boolean;
    console: boolean;
    unsafePublicConsole: boolean;
    eject: boolean;
    force: boolean;
    dryRun: boolean;
    yes: boolean;
    verifyPath: string;        // default '/openapi.json'
    help: boolean;
  }
  export function parseDeployArgs(argv: string[]): DeployArgs;
  ```
- Consumes: `AgentError` from `@agentback/openapi` for an unknown flag / missing target.

- [ ] **Step 1: Write the failing test**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parseDeployArgs} from '../../args.js';

describe('parseDeployArgs', () => {
  it('parses target + defaults', () => {
    const a = parseDeployArgs(['vercel']);
    expect(a.target).toBe('vercel');
    expect(a.prod).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.console).toBe(false);
    expect(a.verifyPath).toBe('/openapi.json');
  });

  it('parses flags and values', () => {
    const a = parseDeployArgs([
      'vercel', '--prod', '--name', 'svc', '--entry', 'dist/main.js',
      '--export', 'buildApp', '--console', '--unsafe-public-console',
      '--eject', '--force', '--dry-run', '--yes', '--verify-path', '/v1/openapi.json',
    ]);
    expect(a).toMatchObject({
      prod: true, name: 'svc', entry: 'dist/main.js', exportName: 'buildApp',
      console: true, unsafePublicConsole: true, eject: true, force: true,
      dryRun: true, yes: true, verifyPath: '/v1/openapi.json',
    });
  });

  it('throws on missing target', () => {
    expect(() => parseDeployArgs([])).toThrow(/target/i);
  });

  it('throws on unknown target', () => {
    expect(() => parseDeployArgs(['cloudflare'])).toThrow(/vercel/i);
  });

  it('throws on unknown flag', () => {
    expect(() => parseDeployArgs(['vercel', '--bogus'])).toThrow(/unknown/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run -t parseDeployArgs`
Expected: FAIL — cannot find module `../../args.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AgentError, ErrorCodes} from '@agentback/openapi';

export interface DeployArgs {
  target: 'vercel';
  entry?: string;
  exportName?: string;
  name?: string;
  prod: boolean;
  console: boolean;
  unsafePublicConsole: boolean;
  eject: boolean;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  verifyPath: string;
  help: boolean;
}

const VALUE_FLAGS = new Set([
  '--entry', '--export', '--name', '--verify-path',
]);
const BOOL_FLAGS = new Set([
  '--prod', '--console', '--unsafe-public-console', '--eject', '--force',
  '--dry-run', '--yes', '-h', '--help',
]);

function bad(message: string): never {
  throw new AgentError(message, {code: ErrorCodes.INVALID_INPUT});
}

export function parseDeployArgs(argv: string[]): DeployArgs {
  const [target, ...rest] = argv;
  if (!target) bad('deploy: missing target. Usage: agentback deploy vercel');
  if (target !== 'vercel') bad(`deploy: unknown target '${target}' (only 'vercel' in Phase 1)`);

  const out: DeployArgs = {
    target: 'vercel', prod: false, console: false, unsafePublicConsole: false,
    eject: false, force: false, dryRun: false, yes: false,
    verifyPath: '/openapi.json', help: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (VALUE_FLAGS.has(f)) {
      const v = rest[++i];
      if (v === undefined) bad(`deploy: ${f} needs a value`);
      if (f === '--entry') out.entry = v;
      else if (f === '--export') out.exportName = v;
      else if (f === '--name') out.name = v;
      else if (f === '--verify-path') out.verifyPath = v;
    } else if (BOOL_FLAGS.has(f)) {
      if (f === '--prod') out.prod = true;
      else if (f === '--console') out.console = true;
      else if (f === '--unsafe-public-console') out.unsafePublicConsole = true;
      else if (f === '--eject') out.eject = true;
      else if (f === '--force') out.force = true;
      else if (f === '--dry-run') out.dryRun = true;
      else if (f === '--yes') out.yes = true;
      else if (f === '-h' || f === '--help') out.help = true;
    } else {
      bad(`deploy: unknown flag '${f}'`);
    }
  }
  return out;
}
```

> Verify `ErrorCodes.INVALID_INPUT` is the correct export name from `@agentback/openapi` (CLAUDE.md references `ErrorCodes.INVALID_INPUT`). If the symbol differs, use the actual one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run -t parseDeployArgs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/args.ts packages/cli/src/__tests__/unit/args.unit.ts
git commit -m "feat(cli): deploy arg parser"
```

---

### Task 3: Generate `api/index.ts`

**Files:**
- Create: `packages/cli/src/generate-entry.ts`, `packages/cli/src/__tests__/unit/generate-entry.unit.ts`

**Interfaces:**
- Consumes: `{entry: string; exportName: string}` (a resolved builder).
- Produces: `export function generateEntry(b: {entry: string; exportName: string}): string;`

- [ ] **Step 1: Write the failing test**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {generateEntry} from '../../generate-entry.js';

describe('generateEntry', () => {
  const src = generateEntry({entry: '../dist/main.js', exportName: 'buildApp'});

  it('imports the resolved builder and entry path', () => {
    expect(src).toContain("import {buildApp} from '../dist/main.js'");
  });

  it('uses Node http types, never @vercel/node', () => {
    expect(src).toContain("from 'node:http'");
    expect(src).not.toContain('@vercel/node');
  });

  it('memoizes the boot and hands Vercel the express app', () => {
    expect(src).toContain('??=');
    expect(src).toContain('restServer');
    expect(src).toContain('expressApp');
    expect(src).toContain('listen: false');
  });

  it('exports a default handler', () => {
    expect(src).toContain('export default async function handler');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run -t generateEntry`
Expected: FAIL — cannot find module `../../generate-entry.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export function generateEntry(b: {entry: string; exportName: string}): string {
  return `// Generated by \`agentback deploy vercel\`. Safe to --eject and edit.
// Vercel owns the listener: boot with listen:false and hand it the Express app.
import type {IncomingMessage, ServerResponse} from 'node:http';
import {${b.exportName}} from '${b.entry}';

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

let booted: Promise<NodeHandler> | undefined;
const app = (): Promise<NodeHandler> =>
  (booted ??= (async () => {
    const a = await ${b.exportName}({listen: false});
    const server = await a.restServer;
    return server.expressApp as unknown as NodeHandler;
  })());

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  (await app())(req, res);
}
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run -t generateEntry`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/generate-entry.ts packages/cli/src/__tests__/unit/generate-entry.unit.ts
git commit -m "feat(cli): generate Vercel api/index.ts entry"
```

---

### Task 4: Order-aware idempotent `vercel.json` merge

**Files:**
- Create: `packages/cli/src/merge-config.ts`, `packages/cli/src/__tests__/unit/merge-config.unit.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface MergeOpts {
    packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
    includeConsoleAssets: boolean;   // true only when --console
    force: boolean;
    eject: boolean;
  }
  export interface MergeResult {json: Record<string, unknown>; warnings: string[];}
  export function mergeVercelConfig(
    existing: Record<string, unknown> | undefined,
    opts: MergeOpts,
  ): MergeResult;
  ```
- Behavior: fresh write when `existing` is undefined; preserve all user keys; **throw `AgentError`** when `existing.rewrites` is a non-empty array and `!force && !eject` (ordered-array conflict); add the console `includeFiles` glob only when `includeConsoleAssets`.

- [ ] **Step 1: Write the failing test**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {mergeVercelConfig} from '../../merge-config.js';

const base = {packageManager: 'pnpm', includeConsoleAssets: false, force: false, eject: false} as const;

describe('mergeVercelConfig', () => {
  it('writes a fresh canonical config (no hardcoded build/public)', () => {
    const {json} = mergeVercelConfig(undefined, base);
    expect(json.rewrites).toEqual([{source: '/(.*)', destination: '/api'}]);
    expect(json.functions).toBeDefined();
    expect(json).not.toHaveProperty('buildCommand');
    expect(json).not.toHaveProperty('outputDirectory');
  });

  it('adds console includeFiles only when requested', () => {
    const off = mergeVercelConfig(undefined, base).json as any;
    expect(off.functions['api/index.ts'].includeFiles).toBeUndefined();
    const on = mergeVercelConfig(undefined, {...base, includeConsoleAssets: true}).json as any;
    expect(on.functions['api/index.ts'].includeFiles).toContain('swagger-ui-dist');
  });

  it('preserves unrelated user keys', () => {
    const {json} = mergeVercelConfig({regions: ['iad1'], headers: []}, base);
    expect(json.regions).toEqual(['iad1']);
    expect(json.headers).toEqual([]);
  });

  it('is idempotent (re-merging its own output changes nothing)', () => {
    const once = mergeVercelConfig(undefined, base).json;
    const twice = mergeVercelConfig(once as any, {...base, force: true}).json;
    expect(twice).toEqual(once);
  });

  it('throws on an existing rewrites array without force/eject', () => {
    expect(() =>
      mergeVercelConfig({rewrites: [{source: '/x', destination: '/y'}]}, base),
    ).toThrow(/rewrites/i);
  });

  it('overwrites rewrites under --force, warning the user', () => {
    const {json, warnings} = mergeVercelConfig(
      {rewrites: [{source: '/x', destination: '/y'}]},
      {...base, force: true},
    );
    expect(json.rewrites).toEqual([{source: '/(.*)', destination: '/api'}]);
    expect(warnings.join(' ')).toMatch(/rewrites/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run -t mergeVercelConfig`
Expected: FAIL — cannot find module `../../merge-config.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AgentError, ErrorCodes} from '@agentback/openapi';

export interface MergeOpts {
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  includeConsoleAssets: boolean;
  force: boolean;
  eject: boolean;
}
export interface MergeResult {
  json: Record<string, unknown>;
  warnings: string[];
}

const CANONICAL_REWRITE = {source: '/(.*)', destination: '/api'};
const CONSOLE_INCLUDE =
  'node_modules/{@agentback/console/dist/client,swagger-ui-dist}/**';

export function mergeVercelConfig(
  existing: Record<string, unknown> | undefined,
  opts: MergeOpts,
): MergeResult {
  const warnings: string[] = [];
  const json: Record<string, unknown> = {...(existing ?? {})};

  // functions.api/index.ts — merge, adding includeFiles only for the console.
  const fns = {...((json.functions as Record<string, unknown>) ?? {})};
  const entry = {...((fns['api/index.ts'] as Record<string, unknown>) ?? {})};
  if (opts.includeConsoleAssets) entry.includeFiles = CONSOLE_INCLUDE;
  else delete entry.includeFiles;
  fns['api/index.ts'] = entry;
  json.functions = fns;

  // rewrites — ORDERED array. Our catch-all must own the whole surface, so we
  // cannot safely interleave with a user's existing rules. Conflict unless the
  // user opted in via --force/--eject.
  const existingRewrites = existing?.rewrites;
  const isCanonical =
    Array.isArray(existingRewrites) &&
    existingRewrites.length === 1 &&
    JSON.stringify(existingRewrites[0]) === JSON.stringify(CANONICAL_REWRITE);
  if (Array.isArray(existingRewrites) && existingRewrites.length > 0 && !isCanonical) {
    if (!opts.force && !opts.eject) {
      throw new AgentError(
        'vercel.json already defines `rewrites`. A catch-all rewrite would ' +
          'override them. Re-run with --force to overwrite, or --eject to ' +
          'merge by hand.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
    if (opts.force) warnings.push('Overwrote existing vercel.json `rewrites`.');
  }
  json.rewrites = [CANONICAL_REWRITE];

  return {json, warnings};
}
```

> `packageManager` is accepted for forward use (e.g. a future inferred `buildCommand`); Phase 1 deliberately omits `buildCommand`/`outputDirectory` so Vercel uses its own detection. Keep the field — Task 8 passes it — but do not emit those keys.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run -t mergeVercelConfig`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/merge-config.ts packages/cli/src/__tests__/unit/merge-config.unit.ts
git commit -m "feat(cli): order-aware idempotent vercel.json merge"
```

---

### Task 5: Builder resolution + console gate

**Files:**
- Create: `packages/cli/src/detect.ts`, `packages/cli/src/__tests__/unit/detect.unit.ts`

**Interfaces:**
- Produces:
  ```ts
  export function resolveBuilder(opts: {
    entry?: string; exportName?: string; cwd: string;
  }): {entry: string; exportName: string};   // throws AgentError if unresolved
  export function enforceConsoleGate(a: {
    console: boolean; unsafePublicConsole: boolean;
  }): void;                                   // throws AgentError when gate fails
  ```
- `resolveBuilder`: when `entry` is given, require `exportName` (default `buildApp`); when absent, probe `cwd` for `dist/console.js` then `dist/main.js` and pick the first that exists, defaulting `exportName` to `buildConsoleApp` (for `console.js`) or `buildApp` (for `main.js`). Throw a clear `AgentError` naming the `--entry`/`--export` contract when nothing resolves.

- [ ] **Step 1: Write the failing test**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resolveBuilder, enforceConsoleGate} from '../../detect.js';

describe('resolveBuilder', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-cli-'));
    mkdirSync(path.join(cwd, 'dist'));
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  it('honors explicit --entry/--export', () => {
    const r = resolveBuilder({entry: './dist/x.js', exportName: 'mk', cwd});
    expect(r).toEqual({entry: './dist/x.js', exportName: 'mk'});
  });

  it('defaults export to buildApp when only --entry given', () => {
    expect(resolveBuilder({entry: './dist/x.js', cwd}).exportName).toBe('buildApp');
  });

  it('detects dist/console.js → buildConsoleApp', () => {
    writeFileSync(path.join(cwd, 'dist', 'console.js'), '');
    expect(resolveBuilder({cwd})).toEqual({entry: './dist/console.js', exportName: 'buildConsoleApp'});
  });

  it('detects dist/main.js → buildApp', () => {
    writeFileSync(path.join(cwd, 'dist', 'main.js'), '');
    expect(resolveBuilder({cwd})).toEqual({entry: './dist/main.js', exportName: 'buildApp'});
  });

  it('throws an actionable error when nothing resolves', () => {
    expect(() => resolveBuilder({cwd})).toThrow(/--entry/);
  });
});

describe('enforceConsoleGate', () => {
  it('no-op when console is off', () => {
    expect(() => enforceConsoleGate({console: false, unsafePublicConsole: false})).not.toThrow();
  });
  it('throws when --console without acknowledgement', () => {
    expect(() => enforceConsoleGate({console: true, unsafePublicConsole: false})).toThrow(/unsafe-public-console/);
  });
  it('allows --console with --unsafe-public-console', () => {
    expect(() => enforceConsoleGate({console: true, unsafePublicConsole: true})).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run detect`
Expected: FAIL — cannot find module `../../detect.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';

export function resolveBuilder(opts: {
  entry?: string;
  exportName?: string;
  cwd: string;
}): {entry: string; exportName: string} {
  if (opts.entry) {
    return {entry: opts.entry, exportName: opts.exportName ?? 'buildApp'};
  }
  const probes: Array<{file: string; entry: string; exportName: string}> = [
    {file: 'dist/console.js', entry: './dist/console.js', exportName: 'buildConsoleApp'},
    {file: 'dist/main.js', entry: './dist/main.js', exportName: 'buildApp'},
  ];
  for (const probe of probes) {
    if (existsSync(path.join(opts.cwd, probe.file))) {
      return {
        entry: probe.entry,
        exportName: opts.exportName ?? probe.exportName,
      };
    }
  }
  throw new AgentError(
    'Could not find a built app builder. Build your app, then pass ' +
      '--entry <built-module> --export <builderFn> (e.g. ' +
      '--entry ./dist/main.js --export buildApp).',
    {code: ErrorCodes.INVALID_INPUT},
  );
}

export function enforceConsoleGate(a: {
  console: boolean;
  unsafePublicConsole: boolean;
}): void {
  if (a.console && !a.unsafePublicConsole) {
    throw new AgentError(
      'Deploying the dev console publishes your DI container, schemas, and ' +
        'MCP inspector. Configure auth, or pass --unsafe-public-console to ' +
        'acknowledge a public, unauthenticated console.',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }
}
```

> The gate is an acknowledgement, not runtime enforcement — `installConsole` still enforces auth at boot. Phase 1 does not introspect the user's builder.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run detect`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/detect.ts packages/cli/src/__tests__/unit/detect.unit.ts
git commit -m "feat(cli): builder resolution and console acknowledgement gate"
```

---

### Task 6: Verify (REST liveness)

**Files:**
- Create: `packages/cli/src/verify.ts`, `packages/cli/src/__tests__/unit/verify.unit.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface VerifyResult {ok: boolean; status: number; body?: string;}
  export function verifyDeploy(
    url: string,
    opts: {verifyPath: string; headers?: Record<string, string>},
    fetchFn?: typeof fetch,
  ): Promise<VerifyResult>;
  ```
- `verifyDeploy` GETs `new URL(verifyPath, url)`; `ok` iff status is 200; on non-200 returns the (truncated) body for the error message. `fetchFn` defaults to `globalThis.fetch` and is injected in tests.

- [ ] **Step 1: Write the failing test**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {verifyDeploy} from '../../verify.js';

function stub(status: number, body: string): typeof fetch {
  return (async (input: any) => {
    void input;
    return new Response(body, {status});
  }) as unknown as typeof fetch;
}

describe('verifyDeploy', () => {
  it('passes on 200', async () => {
    const r = await verifyDeploy('https://x.vercel.app', {verifyPath: '/openapi.json'}, stub(200, '{"openapi":"3.1.1"}'));
    expect(r).toMatchObject({ok: true, status: 200});
  });

  it('fails on non-200 and returns body', async () => {
    const r = await verifyDeploy('https://x.vercel.app', {verifyPath: '/openapi.json'}, stub(500, 'boom'));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.body).toContain('boom');
  });

  it('honors a custom verify path', async () => {
    let seen = '';
    const fetchFn = (async (input: any) => {
      seen = String(input);
      return new Response('{}', {status: 200});
    }) as unknown as typeof fetch;
    await verifyDeploy('https://x.vercel.app', {verifyPath: '/v1/openapi.json'}, fetchFn);
    expect(seen).toBe('https://x.vercel.app/v1/openapi.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run verify`
Expected: FAIL — cannot find module `../../verify.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export interface VerifyResult {
  ok: boolean;
  status: number;
  body?: string;
}

export async function verifyDeploy(
  url: string,
  opts: {verifyPath: string; headers?: Record<string, string>},
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<VerifyResult> {
  const target = new URL(opts.verifyPath, url).toString();
  const res = await fetchFn(target, {headers: opts.headers});
  if (res.status === 200) return {ok: true, status: 200};
  const text = await res.text().catch(() => '');
  return {ok: false, status: res.status, body: text.slice(0, 500)};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run verify`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/verify.ts packages/cli/src/__tests__/unit/verify.unit.ts
git commit -m "feat(cli): REST liveness verify with injectable fetch"
```

---

### Task 7: Shell-out seam + deploy orchestration (dry-run aware)

**Files:**
- Create: `packages/cli/src/exec.ts`, `packages/cli/src/run-vercel.ts`, `packages/cli/src/__tests__/unit/run-vercel.unit.ts`

**Interfaces:**
- Produces:
  ```ts
  // exec.ts
  export interface ExecResult {code: number; stdout: string; stderr: string;}
  export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;
  export const nodeExec: Exec;

  // run-vercel.ts
  export interface RunDeps {exec: Exec; fetchFn: typeof fetch; cwd: string;}
  export interface RunOutcome {status: 'deployed' | 'ejected' | 'dry-run'; url?: string; verify?: import('./verify.js').VerifyResult;}
  export function runVercelDeploy(args: import('./args.js').DeployArgs, deps: RunDeps): Promise<RunOutcome>;
  ```
- `runVercelDeploy` ties Tasks 3–6 together: resolveBuilder → enforceConsoleGate → write `api/index.ts` + merged `vercel.json` at `cwd` root → if `eject` stop (`ejected`) → if `dryRun` run preflight only and stop without exec deploy (`dry-run`) → else preflight, `exec('vercel', [...])`, parse URL from stdout, verify. Preflight runs `exec('vercel', ['whoami'])`; a non-zero code throws an actionable `AgentError`.

- [ ] **Step 1: Write `exec.ts` (no test — thin wrapper)**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {spawn} from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export const nodeExec: Exec = (cmd, args) =>
  new Promise(resolve => {
    const child = spawn(cmd, args, {stdio: ['inherit', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on('data', d => {
      stderr += d;
      process.stderr.write(d);
    });
    child.on('close', code => resolve({code: code ?? 1, stdout, stderr}));
    child.on('error', () => resolve({code: 127, stdout, stderr}));
  });
```

- [ ] **Step 2: Write the failing test for `run-vercel.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runVercelDeploy} from '../../run-vercel.js';
import {parseDeployArgs} from '../../args.js';
import type {Exec} from '../../exec.js';

const okFetch = (async () => new Response('{}', {status: 200})) as unknown as typeof fetch;

function fakeExec(map: Record<string, {code: number; stdout?: string}>): Exec {
  return async (cmd, args) => {
    const key = `${cmd} ${args[0] ?? ''}`.trim();
    const r = map[key] ?? {code: 0};
    return {code: r.code, stdout: r.stdout ?? '', stderr: ''};
  };
}

describe('runVercelDeploy', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-run-'));
    mkdirSync(path.join(cwd, 'dist'));
    writeFileSync(path.join(cwd, 'dist', 'main.js'), '');
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  it('writes root files and stops on --eject', async () => {
    const exec = vi.fn(fakeExec({}));
    const out = await runVercelDeploy(parseDeployArgs(['vercel', '--eject']), {exec, fetchFn: okFetch, cwd});
    expect(out.status).toBe('ejected');
    expect(existsSync(path.join(cwd, 'api', 'index.ts'))).toBe(true);
    expect(existsSync(path.join(cwd, 'vercel.json'))).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('--dry-run preflights but never deploys', async () => {
    const exec = vi.fn(fakeExec({'vercel whoami': {code: 0}}));
    const out = await runVercelDeploy(parseDeployArgs(['vercel', '--dry-run']), {exec, fetchFn: okFetch, cwd});
    expect(out.status).toBe('dry-run');
    // whoami may run; deploy must not.
    const calledDeploy = exec.mock.calls.some(c => c[1][0] === 'deploy');
    expect(calledDeploy).toBe(false);
  });

  it('deploys, parses url, verifies', async () => {
    const exec = fakeExec({
      'vercel whoami': {code: 0},
      'vercel deploy': {code: 0, stdout: 'https://demo-abc.vercel.app\n'},
    });
    const out = await runVercelDeploy(parseDeployArgs(['vercel']), {exec, fetchFn: okFetch, cwd});
    expect(out.status).toBe('deployed');
    expect(out.url).toBe('https://demo-abc.vercel.app');
    expect(out.verify?.ok).toBe(true);
  });

  it('throws an actionable error when not authed', async () => {
    const exec = fakeExec({'vercel whoami': {code: 1}});
    await expect(
      runVercelDeploy(parseDeployArgs(['vercel']), {exec, fetchFn: okFetch, cwd}),
    ).rejects.toThrow(/login/i);
  });

  it('refuses to clobber an existing api/index.ts without --force', async () => {
    mkdirSync(path.join(cwd, 'api'));
    writeFileSync(path.join(cwd, 'api', 'index.ts'), '// user file');
    await expect(
      runVercelDeploy(parseDeployArgs(['vercel', '--eject']), {exec: fakeExec({}), fetchFn: okFetch, cwd}),
    ).rejects.toThrow(/force/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run run-vercel`
Expected: FAIL — cannot find module `../../run-vercel.js`.

- [ ] **Step 4: Write minimal implementation**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {DeployArgs} from './args.js';
import type {Exec} from './exec.js';
import {resolveBuilder, enforceConsoleGate} from './detect.js';
import {generateEntry} from './generate-entry.js';
import {mergeVercelConfig} from './merge-config.js';
import {verifyDeploy, type VerifyResult} from './verify.js';

export interface RunDeps {
  exec: Exec;
  fetchFn: typeof fetch;
  cwd: string;
}
export interface RunOutcome {
  status: 'deployed' | 'ejected' | 'dry-run';
  url?: string;
  verify?: VerifyResult;
}

function detectPackageManager(): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  return 'npm';
}

function writeRootFiles(args: DeployArgs, cwd: string): void {
  const builder = resolveBuilder({entry: args.entry, exportName: args.exportName, cwd});
  // api/index.ts is one level deeper than the builder's dist/ path; the entry
  // string is repo-root-relative, so prefix `../` to reach it from api/.
  const entryFromApi = builder.entry.startsWith('./')
    ? '../' + builder.entry.slice(2)
    : builder.entry;
  const apiDir = path.join(cwd, 'api');
  const apiFile = path.join(apiDir, 'index.ts');
  if (existsSync(apiFile) && !args.force) {
    const current = readFileSync(apiFile, 'utf8');
    if (!current.includes('Generated by `agentback deploy vercel`')) {
      throw new AgentError(
        `api/index.ts already exists and was not generated by agentback. ` +
          `Re-run with --force to overwrite.`,
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
  }
  mkdirSync(apiDir, {recursive: true});
  writeFileSync(apiFile, generateEntry({entry: entryFromApi, exportName: builder.exportName}));

  const vercelPath = path.join(cwd, 'vercel.json');
  const existing = existsSync(vercelPath)
    ? (JSON.parse(readFileSync(vercelPath, 'utf8')) as Record<string, unknown>)
    : undefined;
  const {json, warnings} = mergeVercelConfig(existing, {
    packageManager: detectPackageManager(),
    includeConsoleAssets: args.console,
    force: args.force,
    eject: args.eject,
  });
  for (const w of warnings) console.warn(`warning: ${w}`);
  writeFileSync(vercelPath, JSON.stringify(json, null, 2) + '\n');
}

async function preflight(exec: Exec): Promise<void> {
  const who = await exec('vercel', ['whoami']);
  if (who.code !== 0) {
    throw new AgentError(
      'Vercel CLI is not installed or not authenticated. Install with ' +
        '`npm i -g vercel`, then run `vercel login` (and `vercel link`).',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }
}

function parseUrl(stdout: string): string {
  const m = stdout.match(/https:\/\/\S+\.vercel\.app/);
  if (!m) {
    throw new AgentError('Could not find a deployment URL in vercel output.', {
      code: ErrorCodes.INVALID_INPUT,
    });
  }
  return m[0];
}

export async function runVercelDeploy(
  args: DeployArgs,
  deps: RunDeps,
): Promise<RunOutcome> {
  enforceConsoleGate(args);
  writeRootFiles(args, deps.cwd);
  if (args.eject) return {status: 'ejected'};

  await preflight(deps.exec);
  if (args.dryRun) return {status: 'dry-run'};

  const deployArgs = ['deploy', ...(args.prod ? ['--prod'] : []), ...(args.yes ? ['--yes'] : [])];
  const res = await deps.exec('vercel', deployArgs);
  if (res.code !== 0) {
    throw new AgentError(`vercel deploy failed (exit ${res.code}).`, {
      code: ErrorCodes.INVALID_INPUT,
    });
  }
  const url = parseUrl(res.stdout);
  const verify = await verifyDeploy(url, {verifyPath: args.verifyPath}, deps.fetchFn);
  return {status: 'deployed', url, verify};
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run run-vercel`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/exec.ts packages/cli/src/run-vercel.ts packages/cli/src/__tests__/unit/run-vercel.unit.ts
git commit -m "feat(cli): vercel deploy orchestration with injectable exec/fetch"
```

---

### Task 8: Wire `cli.ts` end-to-end

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/__tests__/unit/cli.unit.ts`

**Interfaces:**
- Consumes: `parseDeployArgs`, `runVercelDeploy`, `nodeExec`. Produces the final `main(argv)` that prints a result summary and maps `AgentError` to a clean stderr line + exit 1; a `verify.ok === false` deploy exits 1.

- [ ] **Step 1: Write the failing test**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it, vi} from 'vitest';
import {main} from '../../cli.js';

describe('main', () => {
  it('prints usage and exits 0 with no args', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main([])).toBe(0);
    log.mockRestore();
  });

  it('maps a bad flag to exit 1 with a clean message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['deploy', 'vercel', '--bogus'])).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/unknown flag/i));
    err.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run cli.unit`
Expected: FAIL — `main(['deploy','vercel','--bogus'])` currently returns the stub's `1` but does not print an "unknown flag" message.

- [ ] **Step 3: Write the implementation**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

#!/usr/bin/env node
import {AgentError} from '@agentback/openapi';
import {parseDeployArgs} from './args.js';
import {runVercelDeploy} from './run-vercel.js';
import {nodeExec} from './exec.js';

export const USAGE = `agentback — deploy an AgentBack app

Usage:
  agentback deploy vercel [options]

Options:
  --entry <path>            built module exporting the app builder
  --export <name>           builder export name (default: buildApp)
  --name <n>                Vercel project name (default: package.json name)
  --prod                    production deploy (default: preview)
  --console                 also deploy the dev console (needs auth or --unsafe-public-console)
  --unsafe-public-console   acknowledge publishing console internals unauthenticated
  --eject                   write api/index.ts + vercel.json, then stop
  --force                   overwrite conflicting vercel.json / api/index.ts
  --dry-run                 generate + preflight only, never deploy
  --verify-path <p>         OpenAPI path to verify (default: /openapi.json)
  --yes                     non-interactive
  -h, --help                show this help
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'deploy') {
    console.log(USAGE);
    return cmd ? 1 : 0;
  }
  try {
    const args = parseDeployArgs(rest);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    const out = await runVercelDeploy(args, {
      exec: nodeExec,
      fetchFn: globalThis.fetch,
      cwd: process.cwd(),
    });
    if (out.status === 'ejected') {
      console.log('Wrote api/index.ts + vercel.json. Run `vercel deploy` to ship.');
      return 0;
    }
    if (out.status === 'dry-run') {
      console.log('Dry run OK: files generated, preflight passed, nothing deployed.');
      return 0;
    }
    if (out.verify && !out.verify.ok) {
      console.error(
        `Deployed to ${out.url} but verify failed ` +
          `(HTTP ${out.verify.status}): ${out.verify.body ?? ''}`,
      );
      return 1;
    }
    console.log(`Deployed and verified: ${out.url}`);
    return 0;
  } catch (e) {
    if (e instanceof AgentError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

const invokedDirectly = process.argv[1]?.endsWith('cli.js');
if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
```

- [ ] **Step 4: Run the full package suite**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli test`
Expected: PASS (all unit suites green).

- [ ] **Step 5: Manual smoke (eject + dry-run against agentback-demo)**

Run:
```bash
cd ../agentback-demo && node ../agentback/packages/cli/dist/cli.js deploy vercel --eject --force && head -5 api/index.ts && cat vercel.json
git checkout -- api vercel.json   # restore the demo's committed files
```
Expected: a generated `api/index.ts` (Node http types) + a `vercel.json` with the catch-all rewrite; then restored.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/cli.ts packages/cli/src/__tests__/unit/cli.unit.ts
git commit -m "feat(cli): wire deploy vercel end-to-end with clean error mapping"
```

---

### Task 9: Opt-in credential-gated e2e

**Files:**
- Create: `packages/cli/src/__tests__/e2e/deploy-vercel.e2e.ts`

**Interfaces:**
- Consumes: `main` from `cli.js`. Runs a REAL `vercel deploy` only when `ABC_E2E_VERCEL=1` and Vercel credentials are present; otherwise the suite is skipped, so default CI never needs creds.

- [ ] **Step 1: Write the gated e2e**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {main} from '../../cli.js';

const RUN = process.env.ABC_E2E_VERCEL === '1';

describe.skipIf(!RUN)('deploy vercel (e2e, credential-gated)', () => {
  it('deploys a fixture and serves /openapi.json', async () => {
    // Runs from a fixture app dir set by the harness (cwd). Requires a linked
    // Vercel project + auth. Asserts a 0 exit (deploy + verify passed).
    const code = await main(['deploy', 'vercel', '--yes']);
    expect(code).toBe(0);
  }, 180_000);
});
```

- [ ] **Step 2: Verify it is skipped by default**

Run: `pnpm -F @agentback/cli build && pnpm -F @agentback/cli exec vitest run deploy-vercel.e2e`
Expected: the suite reports as skipped (no creds, `ABC_E2E_VERCEL` unset).

- [ ] **Step 3: Document the e2e in the README**

Add to `packages/cli/README.md`: how to run the e2e (`ABC_E2E_VERCEL=1` + a linked fixture project), and that it is excluded from default CI.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/__tests__/e2e/deploy-vercel.e2e.ts packages/cli/README.md
git commit -m "test(cli): opt-in credential-gated vercel deploy e2e"
```

---

### Task 10: Workspace verification

**Files:** none (verification only)

- [ ] **Step 1: Full local CI mirror**

Run: `pnpm verify`
Expected: build + typecheck:client + test + validate-templates all green (the new package builds and its tests pass within the workspace).

- [ ] **Step 2: Confirm both bins resolve**

Run: `pnpm -F @agentback/cli exec agentback --help && pnpm -F @agentback/cli exec abc deploy vercel --help`
Expected: USAGE prints for both names.

- [ ] **Step 3: Commit any lockfile/reference fixups**

```bash
git add -A
git commit -m "chore(cli): workspace wiring verified (pnpm verify green)"
```

---

## Self-Review

**Spec coverage:** §2 decisions 1–9 all map to tasks — CLI/bins (T1), surface default + console gate (T5/T7), root files (T7), entry contract (T5), Node types (T3), inline generation (T3), order-aware merge (T4), no abstraction (whole plan is concrete), MCP deferred (absent by construction). §5 pipeline = T5→T7→T8. §6 merge semantics = T4. §8 tests = T2–T9. §9 failure modes = T5/T7 error paths. No gaps.

**Placeholder scan:** every code step carries full code; no TBD/TODO/"similar to". OK.

**Type consistency:** `DeployArgs.exportName` (not `export`, a reserved word) used consistently across T2/T5/T7. `RunDeps`/`RunOutcome`/`VerifyResult`/`MergeOpts`/`MergeResult` names match across tasks. `Exec`/`ExecResult` consistent. `generateEntry` takes `{entry, exportName}` everywhere. OK.

**Pre-verified (no action needed):**
- `@agentback/openapi` exports `AgentError` and `ErrorCodes.INVALID_INPUT` (`= 'invalid_input'`) from its barrel (`packages/openapi/src/agent-error.ts:48,104`, re-exported via `index.ts`); constructor is `new AgentError(message, {code})`. The plan's imports/usage match.
- The builder contract `await builder({listen:false})` → `await app.restServer` → `.expressApp` is verified against `agentback-demo/api/index.ts`. If a REST-only template's builder differs, the two lines inside `generateEntry` (Task 3) are the only thing to adjust.
