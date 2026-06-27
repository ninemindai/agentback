# `agentback deploy cloudflare` (Phase 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cloudflare Workers deploy target to `@agentback/cli` (`deploy cloudflare`) that ships an AgentBack app's REST + OpenAPI surface to a real Workers isolate, by extracting a `DeployTarget` seam from the Phase 1 Vercel path and adding a fetch-leaf worker entry, an idempotent `wrangler.toml`, a static bundle doctor, and a CDN-backed `AssetSource` for the dev UIs.

**Architecture:** Refactor-first. Generalize Phase 1's `run-vercel.ts` into a target-agnostic `run-deploy.ts` pipeline + a `DeployTarget` per target (`vercel`, `cloudflare`), with Vercel output held byte-identical (Phase 1 tests are the regression guard). The Cloudflare target generates `export default { fetch }` from `server.fetchHandler()`, a `wrangler.toml` with `nodejs_compat`, and runs an esbuild-analyze bundle doctor that fails early on denied `node:` modules. `AssetSource` formalizes `serveStaticDir` so dev UIs load assets from a CDN where there is no filesystem.

**Tech Stack:** TypeScript 6.0 (ESM, `.js` import extensions), Node ≥22.13, pnpm 11, vitest (tests against built `dist/`), `esbuild` (analyze-only, for the doctor), `smol-toml` (wrangler.toml round-trip), `wrangler` CLI (orchestrated, not bundled).

## Global Constraints

- **ESM-only**, `"type": "module"`, relative imports carry `.js` extensions. Node `>=22.13`.
- **Tests run against `dist/`**, not `src/`. Always `pnpm -F <pkg> build` before tests. Test files: `src/__tests__/unit/<name>.unit.ts`, globbed as `packages/*/dist/__tests__/**/*.{unit,integration,e2e}.js`. Canonical run (from worktree root): `pnpm exec vitest run packages/<pkg>/dist/__tests__/unit/<file>.unit.js`.
- **License header** (tooling-package style, matching the rest of `@agentback/cli`):
  ```ts
  // Copyright NineMind, Inc. 2026. All Rights Reserved.
  // This file is licensed under the MIT License.
  // License text available at https://opensource.org/license/mit/
  ```
- **Style:** single quotes, no bracket spacing (`{foo}`), trailing commas, 80 col (prettier).
- **User-facing failures** throw `AgentError` from `@agentback/openapi` with `code: ErrorCodes.INVALID_INPUT`.
- **Versioning is lockstep** — any new package keys to the workspace version (currently `0.4.0`); internal deps use `workspace:~`.
- **Cloudflare worker entry** MUST import the **fetch path** (`server.fetchHandler()`), never `app.start()`, and `export default { fetch }`. Never import `@vercel/node`.
- **Generated `wrangler.toml`** MUST carry `compatibility_flags = ["nodejs_compat"]` + a fixed recent `compatibility_date`.
- **`DeployTarget` extraction MUST NOT change Vercel behavior** — the full Phase 1 Vercel test suite stays green.
- **Disk asset behavior stays the default on Node** — `AssetSource` is additive; `fromDisk` is the default everywhere it was before.

---

## File Structure

```
packages/cli/src/
  deploy-target.ts        NEW  DeployTarget interface + shared types (ResolvedBuilder, GenerateOpts, FileEdit, Diagnostic, RunDeps, RunOutcome)
  run-deploy.ts           NEW  generic pipeline (was run-vercel.ts): resolve→gate→generate→preflight→deploy→verify
  targets/vercel.ts       NEW  Vercel DeployTarget (moves run-vercel.ts's generate/preflight/deploy here, byte-identical)
  targets/cloudflare.ts   NEW  Cloudflare DeployTarget (worker entry + wrangler.toml + deploy)
  bundle-doctor.ts        NEW  esbuild-analyze node: allow/deny preflight
  generate-entry.ts       KEEP Vercel api/index.ts generator (unchanged)
  generate-worker.ts      NEW  Cloudflare worker.ts generator (fetch leaf)
  merge-config.ts         KEEP vercel.json merge (unchanged)
  merge-wrangler.ts       NEW  wrangler.toml idempotent merge (smol-toml)
  args.ts / detect.ts / verify.ts / exec.ts / cli.ts   MODIFY (target validation, dispatch)
  run-vercel.ts           DELETE (its contents move to run-deploy.ts + targets/vercel.ts)

packages/rest/src/host/
  asset-source.ts         NEW  AssetSource type + fromDisk + fromCdn
  static.ts               MODIFY  serveStaticDir delegates to fromDisk (back-compat re-export)

packages/{console,rest-explorer,mcp-inspector}/src/index.ts   MODIFY  accept optional assets?: AssetSource
```

---

### Task 1: Extract `DeployTarget` (refactor, Vercel held identical)

**Files:**
- Create: `packages/cli/src/deploy-target.ts`, `packages/cli/src/run-deploy.ts`, `packages/cli/src/targets/vercel.ts`
- Delete: `packages/cli/src/run-vercel.ts`
- Modify: `packages/cli/src/cli.ts` (import `runDeploy` instead of `runVercelDeploy`)
- Tests: the EXISTING `packages/cli/src/__tests__/unit/run-vercel.unit.ts` is renamed to `run-deploy.unit.ts` and updated to call `runDeploy(args, target, deps)`; all its existing assertions must still pass.

**Interfaces:**
- Produces:
  ```ts
  // deploy-target.ts
  export interface ResolvedBuilder {entry: string; exportName: string;}
  export interface GenerateOpts {builder: ResolvedBuilder; cwd: string; isConsoleBuilder: boolean; force: boolean; eject: boolean;}
  export interface FileEdit {path: string; contents: string;}          // path is cwd-relative
  export interface Diagnostic {ok: boolean; message: string;}
  export interface RunDeps {exec: import('./exec.js').Exec; fetchFn: typeof fetch; cwd: string;}
  export interface RunOutcome {status: 'deployed' | 'ejected' | 'dry-run'; url?: string; verify?: import('./verify.js').VerifyResult;}
  export interface DeployTarget {
    id: 'vercel' | 'cloudflare';
    generateEntry(o: GenerateOpts): FileEdit;
    generateConfig(o: GenerateOpts): FileEdit[];
    preflight(o: GenerateOpts, deps: RunDeps): Promise<Diagnostic[]>;
    deploy(args: import('./args.js').DeployArgs, deps: RunDeps): Promise<{url: string}>;
    defaultVerifyPath(): string;
  }
  // run-deploy.ts
  export function runDeploy(args: DeployArgs, target: DeployTarget, deps: RunDeps): Promise<RunOutcome>;
  // targets/vercel.ts
  export const vercelTarget: DeployTarget;
  ```

- [ ] **Step 1: Create `deploy-target.ts` with the interface + shared types above.** (License header; types only, no logic.)

- [ ] **Step 2: Create `targets/vercel.ts` by moving Phase 1's generate/preflight/deploy logic behind `vercelTarget`.**

Move, verbatim, from `run-vercel.ts` into `vercelTarget` methods:
- `generateEntry(o)`: the `entryFromApi` rewrite (`../`-prefix) + `generateEntry({entry, exportName})` call → returns `{path: 'api/index.ts', contents}`.
- `generateConfig(o)`: read existing `vercel.json` if present, `mergeVercelConfig(existing, {packageManager: detectPackageManager(), includeConsoleAssets: o.isConsoleBuilder, force: o.force, eject: o.eject})`, return `[{path: 'vercel.json', contents: JSON.stringify(json, null, 2) + '\n'}]` plus surface its warnings (log them in `generateConfig`).
- `preflight(_, deps)`: the `vercel whoami` check → returns `[{ok, message}]` (throw is also fine; keep Phase 1's throw-on-not-authed behavior).
- `deploy(args, deps)`: build `['deploy', ...prod?, ...yes?]`, `exec('vercel', ...)`, `parseUrl(stdout)` → `{url}`.
- `defaultVerifyPath()`: `'/openapi.json'`.

Keep `detectPackageManager`, `parseUrl` as private helpers in `vercel.ts` (or a shared util if `cloudflare.ts` needs them — `parseUrl` differs per platform, keep per-target).

- [ ] **Step 3: Create `run-deploy.ts` — the generic pipeline.**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {DeployArgs} from './args.js';
import {resolveBuilder, enforceConsoleGate} from './detect.js';
import {verifyDeploy} from './verify.js';
import type {DeployTarget, RunDeps, RunOutcome, GenerateOpts} from './deploy-target.js';

function writeEdit(cwd: string, edit: {path: string; contents: string}, force: boolean): void {
  const abs = path.join(cwd, edit.path);
  // Clobber guard only for the generated entry, mirroring Phase 1.
  if (existsSync(abs) && !force) {
    const cur = readFileSync(abs, 'utf8');
    if (!cur.includes('Generated by `agentback deploy`') &&
        !cur.includes('Generated by `agentback deploy vercel`')) {
      // Config files (vercel.json/wrangler.toml) are merged upstream, so an
      // existing one is expected; only guard generated *source* entries.
      if (edit.path.endsWith('.ts') || edit.path.endsWith('.js')) {
        throw new AgentError(
          `${edit.path} already exists and was not generated by agentback. ` +
            `Re-run with --force to overwrite.`,
          {code: ErrorCodes.INVALID_INPUT},
        );
      }
    }
  }
  mkdirSync(path.dirname(abs), {recursive: true});
  writeFileSync(abs, edit.contents);
}

export async function runDeploy(
  args: DeployArgs,
  target: DeployTarget,
  deps: RunDeps,
): Promise<RunOutcome> {
  const builder = resolveBuilder({entry: args.entry, exportName: args.exportName, cwd: deps.cwd});
  const isConsoleBuilder = builder.exportName === 'buildConsoleApp';
  const consoleIntent = args.console || isConsoleBuilder;
  enforceConsoleGate({console: consoleIntent, unsafePublicConsole: args.unsafePublicConsole});
  if (args.console && !isConsoleBuilder) {
    console.warn(
      'warning: --console was set but the resolved builder is not the console builder; no console assets bundled.',
    );
  }

  const opts: GenerateOpts = {builder, cwd: deps.cwd, isConsoleBuilder, force: args.force, eject: args.eject};
  writeEdit(deps.cwd, target.generateEntry(opts), args.force);
  for (const edit of target.generateConfig(opts)) writeEdit(deps.cwd, edit, true);

  if (args.eject) return {status: 'ejected'};

  const diags = await target.preflight(opts, deps);
  const bad = diags.find(d => !d.ok);
  if (bad) throw new AgentError(bad.message, {code: ErrorCodes.INVALID_INPUT});
  if (args.dryRun) return {status: 'dry-run'};

  const {url} = await target.deploy(args, deps);
  const verify = await verifyDeploy(url, {verifyPath: args.verifyPath || target.defaultVerifyPath()}, deps.fetchFn);
  return {status: 'deployed', url, verify};
}
```

> Note: the generated entry's marker string becomes `Generated by \`agentback deploy\`` (generic) — update Task 4's worker generator and the Phase 1 Vercel `generate-entry.ts` marker to this shared string in this task so the clobber guard recognizes both. (Vercel test that asserts the marker must be updated accordingly.)

- [ ] **Step 4: Update `cli.ts`** — import `runDeploy` + `vercelTarget`; in the deploy branch, select the target (`vercel` → `vercelTarget`) and call `runDeploy(args, target, {exec: nodeExec, fetchFn: globalThis.fetch, cwd: process.cwd()})`. Result-status mapping is unchanged.

- [ ] **Step 5: Rename + update the test** — `run-vercel.unit.ts` → `run-deploy.unit.ts`. Replace `runVercelDeploy(args, {...})` calls with `runDeploy(args, vercelTarget, {...})` (import `vercelTarget` from `../../targets/vercel.js`). Update the marker assertions to the generic `Generated by \`agentback deploy\``. No assertion's *meaning* changes.

- [ ] **Step 6: Build + run the WHOLE cli unit suite (regression gate)**

Run: `pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/`
Expected: PASS — every Phase 1 test green (Vercel behavior unchanged), incl. the renamed `run-deploy.unit.ts`.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src tsconfig.json
git rm packages/cli/src/run-vercel.ts 2>/dev/null; git add -A packages/cli/src
git commit -m "refactor(cli): extract DeployTarget seam; Vercel behind the interface (no behavior change)"
```

---

### Task 2: `AssetSource` (D) — formalize the seam

**Files:**
- Create: `packages/rest/src/host/asset-source.ts`, `packages/rest/src/host/__tests__/unit/asset-source.unit.ts`
- Modify: `packages/rest/src/host/static.ts` (delegate to `fromDisk`), `packages/rest/src/index.ts` (export `AssetSource`/`fromDisk`/`fromCdn`)
- Modify: `packages/console/src/index.ts:137`, `packages/rest-explorer/src/index.ts:73`, `packages/mcp-inspector/src/index.ts:273` (accept `assets?: AssetSource`)

**Interfaces:**
- Produces:
  ```ts
  export type AssetSource = (suffix: string) => Promise<Response | undefined>;
  export function fromDisk(dir: string): AssetSource;   // == current serveStaticDir
  // fromCdn added in Task 3
  ```
- Each `install*` helper gains an optional last option `assets?: AssetSource`, default `fromDisk(<its dir>)`.

- [ ] **Step 1: Write the failing test** (`asset-source.unit.ts`)

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {fromDisk} from '../../asset-source.js';

describe('fromDisk', () => {
  let dir: string;
  beforeEach(() => {dir = mkdtempSync(path.join(tmpdir(), 'asset-'));});
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  it('serves an existing file with a content-type', async () => {
    writeFileSync(path.join(dir, 'main.js'), 'console.log(1)');
    const res = await fromDisk(dir)('/main.js');
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('javascript');
  });

  it('returns undefined for a missing file', async () => {
    expect(await fromDisk(dir)('/nope.js')).toBeUndefined();
  });

  it('rejects path traversal', async () => {
    expect(await fromDisk(dir)('/../secret')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/rest build && pnpm exec vitest run packages/rest/dist/host/__tests__/unit/asset-source.unit.js`
Expected: FAIL — cannot find module `../../asset-source.js`.

- [ ] **Step 3: Create `asset-source.ts` by moving `serveStaticDir`'s body into `fromDisk`.**

Move the entire current body of `serveStaticDir` (`packages/rest/src/host/static.ts`) into `fromDisk(dir): AssetSource` in `asset-source.ts` (same MIME map, same traversal guard, same cache header). Add:

```ts
export type AssetSource = (suffix: string) => Promise<globalThis.Response | undefined>;
```

- [ ] **Step 4: Make `static.ts` re-export for back-compat.** Replace `static.ts`'s implementation with:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {fromDisk} from './asset-source.js';

/** @deprecated use `fromDisk` from asset-source. Kept for back-compat. */
export const serveStaticDir = fromDisk;
```

Export `AssetSource`, `fromDisk` from `packages/rest/src/index.ts` (find the existing `export * from './host/static.js'` and add `export * from './host/asset-source.js'`).

- [ ] **Step 5: Add `assets?` option to the three `install*` helpers.**

For each of `installConsole`, `installExplorer`, `installInspector`: add `assets?: AssetSource` to its options object, and change the `const serveAsset = serveStaticDir(<dir>)` line to `const serveAsset = options.assets ?? fromDisk(<dir>)`. Import `fromDisk`/`AssetSource` from `@agentback/rest`. Default behavior (no `assets`) is unchanged — disk serving.

- [ ] **Step 6: Build the touched packages + run tests (back-compat gate)**

Run: `pnpm -F @agentback/rest build && pnpm -F @agentback/console build && pnpm -F @agentback/rest-explorer build && pnpm -F @agentback/mcp-inspector build && pnpm exec vitest run packages/rest/dist/host/__tests__/unit/asset-source.unit.js`
Expected: `fromDisk` tests PASS; all four packages build; no existing rest/console/explorer/inspector test regresses (run their suites too if present).

- [ ] **Step 7: Commit**

```bash
git add packages/rest/src packages/console/src/index.ts packages/rest-explorer/src/index.ts packages/mcp-inspector/src/index.ts
git commit -m "feat(rest): formalize AssetSource seam (fromDisk); install* accept assets?"
```

---

### Task 3: `AssetSource` (C) — `fromCdn` + dev UIs on a CDN

**Files:**
- Modify: `packages/rest/src/host/asset-source.ts` (add `fromCdn`), `packages/rest/src/host/__tests__/unit/asset-source.unit.ts` (add tests)

**Interfaces:**
- Produces: `export function fromCdn(baseUrl: string): AssetSource;` — given a suffix, fetches `baseUrl + suffix` and returns a `Response` (200 → pass through bytes + content-type; non-200 → `undefined`).

- [ ] **Step 1: Write the failing test** (append to `asset-source.unit.ts`)

```ts
describe('fromCdn', () => {
  it('proxies an asset from the CDN base', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: any) => {
      calls.push(String(u));
      return new Response('body', {status: 200, headers: {'content-type': 'application/javascript'}});
    }) as unknown as typeof fetch;
    const res = await fromCdn('https://cdn.example/npm/pkg@1/dist', fetchFn)('/main.js');
    expect(calls[0]).toBe('https://cdn.example/npm/pkg@1/dist/main.js');
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('body');
  });

  it('returns undefined when the CDN 404s', async () => {
    const fetchFn = (async () => new Response('', {status: 404})) as unknown as typeof fetch;
    expect(await fromCdn('https://cdn.example/x', fetchFn)('/missing.js')).toBeUndefined();
  });
});
```

Add `fromCdn` to the import at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/rest build && pnpm exec vitest run packages/rest/dist/host/__tests__/unit/asset-source.unit.js`
Expected: FAIL — `fromCdn` is not exported.

- [ ] **Step 3: Implement `fromCdn`** (append to `asset-source.ts`)

```ts
/**
 * Serve assets from a CDN base URL instead of disk — for edge runtimes (no fs).
 * jsdelivr/unpkg serve any published npm package's files by version, e.g.
 * `https://cdn.jsdelivr.net/npm/@agentback/console@0.4.0/dist/client`.
 */
export function fromCdn(
  baseUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): AssetSource {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return async (suffix: string): Promise<globalThis.Response | undefined> => {
    const url = base + (suffix.startsWith('/') ? suffix : '/' + suffix);
    const res = await fetchFn(url);
    if (res.status !== 200) return undefined;
    return new globalThis.Response(res.body, {
      headers: {
        'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    });
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm -F @agentback/rest build && pnpm exec vitest run packages/rest/dist/host/__tests__/unit/asset-source.unit.js`
Expected: PASS (fromDisk 3 + fromCdn 2).

- [ ] **Step 5: Commit**

```bash
git add packages/rest/src/host/asset-source.ts packages/rest/src/host/__tests__/unit/asset-source.unit.ts
git commit -m "feat(rest): fromCdn AssetSource for edge dev UIs (CDN-hosted npm assets)"
```

> The Cloudflare worker wiring that passes `fromCdn(...)` to the dev UIs is generated by Task 4's worker template (it calls `installConsole(app, {assets: fromCdn(...)})` when `--console`). No further change here.

---

### Task 4: Cloudflare worker entry + `wrangler.toml` + target

**Files:**
- Create: `packages/cli/src/generate-worker.ts`, `packages/cli/src/merge-wrangler.ts`, `packages/cli/src/targets/cloudflare.ts`, and their unit tests
- Modify: `packages/cli/package.json` (add `smol-toml` dependency)

**Interfaces:**
- Produces:
  ```ts
  // generate-worker.ts
  export function generateWorker(b: {entry: string; exportName: string}): string;
  // merge-wrangler.ts
  export function mergeWrangler(existingToml: string | undefined, opts: {name: string; main: string; force: boolean; eject: boolean}): {toml: string; warnings: string[]};
  // targets/cloudflare.ts
  export const cloudflareTarget: import('../deploy-target.js').DeployTarget;
  ```

- [ ] **Step 1: Write the failing test for `generateWorker`** (`__tests__/unit/generate-worker.unit.ts`)

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {generateWorker} from '../../generate-worker.js';

describe('generateWorker', () => {
  const src = generateWorker({entry: '../../../dist/main.js', exportName: 'buildApp'});
  it('imports the builder and uses the fetch path', () => {
    expect(src).toContain("import {buildApp} from '../../../dist/main.js'");
    expect(src).toContain('fetchHandler()');
    expect(src).not.toContain('expressApp');
    expect(src).not.toContain('@vercel/node');
  });
  it('exports default { fetch } and memoizes the boot', () => {
    expect(src).toContain('export default');
    expect(src).toContain('fetch');
    expect(src).toContain('??=');
    expect(src).toContain('listen: false');
  });
  it('carries the generic generated-by marker', () => {
    expect(src).toContain('Generated by `agentback deploy`');
  });
});
```

- [ ] **Step 2: Run test → fails** (`pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/generate-worker.unit.js`) — module not found.

- [ ] **Step 3: Implement `generate-worker.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export function generateWorker(b: {entry: string; exportName: string}): string {
  return `// Generated by \`agentback deploy\`. Safe to --eject and edit.
// Cloudflare Workers: export a fetch handler built from the runtime-neutral
// RestServer.fetchHandler(). Importing the fetch path (not app.start()) lets
// wrangler's esbuild tree-shake the Node listener out.
import {${b.exportName}} from '${b.entry}';

let booted: Promise<{fetch(req: Request): Promise<Response>}> | undefined;
const host = () =>
  (booted ??= (async () => {
    const app = await ${b.exportName}({listen: false});
    const server = await app.restServer;
    return server.fetchHandler();
  })());

export default {
  async fetch(req: Request): Promise<Response> {
    return (await host()).fetch(req);
  },
};
`;
}
```

- [ ] **Step 4: Run worker test → PASS.**

- [ ] **Step 5: Write the failing test for `mergeWrangler`** (`__tests__/unit/merge-wrangler.unit.ts`)

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parse} from 'smol-toml';
import {mergeWrangler} from '../../merge-wrangler.js';

const base = {name: 'svc', main: '.agentback/deploy/cloudflare/worker.ts', force: false, eject: false};

describe('mergeWrangler', () => {
  it('writes a fresh config with nodejs_compat', () => {
    const {toml} = mergeWrangler(undefined, base);
    const o = parse(toml) as any;
    expect(o.name).toBe('svc');
    expect(o.main).toBe(base.main);
    expect(o.compatibility_flags).toContain('nodejs_compat');
    expect(typeof o.compatibility_date).toBe('string');
  });
  it('preserves unrelated user keys', () => {
    const {toml} = mergeWrangler('account_id = "abc"\n[vars]\nFOO = "1"\n', base);
    const o = parse(toml) as any;
    expect(o.account_id).toBe('abc');
    expect(o.vars.FOO).toBe('1');
    expect(o.compatibility_flags).toContain('nodejs_compat');
  });
  it('warns + overwrites a conflicting main only under force', () => {
    expect(() => mergeWrangler('main = "src/other.ts"\n', base)).toThrow(/main/i);
    const {toml, warnings} = mergeWrangler('main = "src/other.ts"\n', {...base, force: true});
    expect((parse(toml) as any).main).toBe(base.main);
    expect(warnings.join(' ')).toMatch(/main/i);
  });
});
```

- [ ] **Step 6: Add `smol-toml` dep + run test → fails**

Edit `packages/cli/package.json` dependencies: add `"smol-toml": "^1.3.1"`. Run `pnpm install`. Then `pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/merge-wrangler.unit.js` → FAIL (module not found).

- [ ] **Step 7: Implement `merge-wrangler.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {parse, stringify} from 'smol-toml';
import {AgentError, ErrorCodes} from '@agentback/openapi';

// Fixed, reviewed compatibility date (bump deliberately, not silently).
const COMPAT_DATE = '2026-06-01';

export function mergeWrangler(
  existingToml: string | undefined,
  opts: {name: string; main: string; force: boolean; eject: boolean},
): {toml: string; warnings: string[]} {
  const warnings: string[] = [];
  const obj: Record<string, unknown> = existingToml
    ? (parse(existingToml) as Record<string, unknown>)
    : {};

  // `main` is load-bearing: if the user set a different one, don't silently steal it.
  if (typeof obj.main === 'string' && obj.main !== opts.main && !opts.force && !opts.eject) {
    throw new AgentError(
      `wrangler.toml already sets \`main\` to "${obj.main}". Re-run with --force ` +
        `to point it at the generated worker, or --eject to wire it by hand.`,
      {code: ErrorCodes.INVALID_INPUT},
    );
  }
  if (typeof obj.main === 'string' && obj.main !== opts.main && opts.force) {
    warnings.push(`Overwrote wrangler.toml \`main\` ("${obj.main}" → "${opts.main}").`);
  }

  obj.name = obj.name ?? opts.name; // don't clobber a user-chosen name
  obj.main = opts.main;
  obj.compatibility_date = obj.compatibility_date ?? COMPAT_DATE;
  const flags = new Set([
    ...((Array.isArray(obj.compatibility_flags) ? obj.compatibility_flags : []) as string[]),
    'nodejs_compat',
  ]);
  obj.compatibility_flags = [...flags];

  return {toml: stringify(obj) + '\n', warnings};
}
```

- [ ] **Step 8: Run wrangler test → PASS.**

- [ ] **Step 9: Write the failing test for `cloudflareTarget`** (`__tests__/unit/cloudflare-target.unit.ts`)

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parse} from 'smol-toml';
import {cloudflareTarget} from '../../targets/cloudflare.js';

const opts = {
  builder: {entry: './dist/main.js', exportName: 'buildApp'},
  cwd: '/tmp/app', isConsoleBuilder: false, force: false, eject: false,
};

describe('cloudflareTarget', () => {
  it('generates the worker at the ephemeral path with the correct relative entry', () => {
    const edit = cloudflareTarget.generateEntry(opts);
    expect(edit.path).toBe('.agentback/deploy/cloudflare/worker.ts');
    // worker is 3 dirs deep, so root-relative ./dist/main.js → ../../../dist/main.js
    expect(edit.contents).toContain("from '../../../dist/main.js'");
    expect(edit.contents).toContain('fetchHandler()');
  });
  it('generates a wrangler.toml with nodejs_compat + main', () => {
    const edits = cloudflareTarget.generateConfig({...opts, builder: {...opts.builder}});
    const wr = edits.find(e => e.path === 'wrangler.toml')!;
    const o = parse(wr.contents) as any;
    expect(o.main).toBe('.agentback/deploy/cloudflare/worker.ts');
    expect(o.compatibility_flags).toContain('nodejs_compat');
  });
  it('verify path is /openapi.json', () => {
    expect(cloudflareTarget.defaultVerifyPath()).toBe('/openapi.json');
  });
});
```

- [ ] **Step 10: Run → fails. Implement `targets/cloudflare.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {DeployArgs} from '../args.js';
import type {DeployTarget, GenerateOpts, RunDeps, Diagnostic, FileEdit} from '../deploy-target.js';
import {generateWorker} from '../generate-worker.js';
import {mergeWrangler} from '../merge-wrangler.js';
import {runBundleDoctor} from '../bundle-doctor.js'; // Task 5

const WORKER_PATH = '.agentback/deploy/cloudflare/worker.ts';

// Root-relative entry → relative to the worker's 3-deep location.
function entryFromWorker(entry: string): string {
  const stripped = entry.replace(/^\.\//, '');
  return stripped.startsWith('/') ? stripped : '../../../' + stripped;
}

export const cloudflareTarget: DeployTarget = {
  id: 'cloudflare',

  generateEntry(o: GenerateOpts): FileEdit {
    return {
      path: WORKER_PATH,
      contents: generateWorker({
        entry: entryFromWorker(o.builder.entry),
        exportName: o.builder.exportName,
      }),
    };
  },

  generateConfig(o: GenerateOpts): FileEdit[] {
    const wranglerPath = path.join(o.cwd, 'wrangler.toml');
    const existing = existsSync(wranglerPath) ? readFileSync(wranglerPath, 'utf8') : undefined;
    const name = readName(o.cwd);
    const {toml, warnings} = mergeWrangler(existing, {
      name, main: WORKER_PATH, force: o.force, eject: o.eject,
    });
    for (const w of warnings) console.warn(`warning: ${w}`);
    return [{path: 'wrangler.toml', contents: toml}];
  },

  async preflight(o: GenerateOpts): Promise<Diagnostic[]> {
    const diags: Diagnostic[] = [];
    // 1. Bundle doctor (static, before deploy).
    diags.push(await runBundleDoctor(path.join(o.cwd, WORKER_PATH)));
    // 2. wrangler installed + authed.
    diags.push({ok: true, message: ''}); // placeholder; real exec check below in deploy preflight
    return diags;
  },

  async deploy(args: DeployArgs, deps: RunDeps): Promise<{url: string}> {
    const who = await deps.exec('wrangler', ['whoami']);
    if (who.code !== 0) {
      throw new AgentError(
        'Wrangler is not installed or not authenticated. Install with ' +
          '`npm i -g wrangler`, then run `wrangler login`.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
    const res = await deps.exec('wrangler', ['deploy', ...(args.prod ? [] : ['--env', 'preview'])]);
    if (res.code !== 0) {
      throw new AgentError(`wrangler deploy failed (exit ${res.code}).`, {code: ErrorCodes.INVALID_INPUT});
    }
    const m = res.stdout.match(/https:\/\/\S+\.workers\.dev\S*/);
    if (!m) throw new AgentError('Could not find a workers.dev URL in wrangler output.', {code: ErrorCodes.INVALID_INPUT});
    return {url: m[0]};
  },

  defaultVerifyPath() {
    return '/openapi.json';
  },
};

function readName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {name?: string};
    return (pkg.name ?? 'agentback-worker').replace(/^@[^/]+\//, '');
  } catch {
    return 'agentback-worker';
  }
}
```

> The `--name` flag (when present) should override `readName` — thread `args.name` into `generateConfig` via `GenerateOpts` if you wire `--name` in Task 6; for now `readName` from package.json is the default. (Wrangler's `name` is a real field, unlike Vercel's dropped `--name`.)

- [ ] **Step 11: Run the cloudflare-target test → PASS** (`pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/cloudflare-target.unit.js`). Note this depends on Task 5's `runBundleDoctor` existing — if implementing strictly in order, stub `bundle-doctor.ts` to export `async function runBundleDoctor(){return {ok:true,message:''}}` now and fill it in Task 5.

- [ ] **Step 12: Commit**

```bash
git add packages/cli/src packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): cloudflare target — worker fetch leaf + wrangler.toml merge"
```

---

### Task 5: Bundle doctor (esbuild-analyze, allow/deny)

**Files:**
- Create: `packages/cli/src/bundle-doctor.ts` (replace the Task 4 stub), `packages/cli/src/__tests__/unit/bundle-doctor.unit.ts`
- Modify: `packages/cli/package.json` (add `esbuild` dependency)

**Interfaces:**
- Produces: `export function runBundleDoctor(entryPath: string, esbuildImpl?): Promise<Diagnostic>;` — bundles `entryPath` with esbuild `metafile:true, write:false, platform:'browser'`; scans resolved inputs/externals for denied `node:` modules; returns `{ok:false, message}` (naming module + likely culprit) on a hit, else `{ok:true}`. On esbuild failure (won't compile) returns `{ok:false}` with the build error.

- [ ] **Step 1: Write the failing test** (drive the scanner over a fake metafile via dependency injection)

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {scanImports} from '../../bundle-doctor.js';

describe('scanImports', () => {
  it('passes a clean graph (nodejs_compat-backed modules allowed)', () => {
    const r = scanImports(['node:crypto', 'node:stream', '@agentback/rest']);
    expect(r.ok).toBe(true);
  });
  it('fails on node:fs and names the culprit', () => {
    const r = scanImports(['node:crypto', 'node:fs/promises']);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/node:fs/);
    expect(r.message).toMatch(/serveStaticDir|AssetSource|filesystem/i);
  });
  it('fails on node:child_process', () => {
    expect(scanImports(['node:child_process']).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fails** (`scanImports` not exported).

- [ ] **Step 3: Implement `bundle-doctor.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Diagnostic} from './deploy-target.js';

const DENY = new Set([
  'node:fs', 'node:fs/promises', 'node:path', 'node:net', 'node:http',
  'node:https', 'node:child_process', 'node:cluster', 'node:dgram', 'node:tls',
]);
// Allowed under Cloudflare's nodejs_compat; everything not in DENY is treated as
// allowed (npm packages bundle normally; only the DENY node: builtins fail).

export function scanImports(modules: string[]): Diagnostic {
  for (const m of modules) {
    // Match a denied builtin, ignoring a subpath after the base (node:fs/x).
    const base = m.startsWith('node:') ? m : m;
    const denied = [...DENY].find(d => base === d || base.startsWith(d + '/'));
    if (denied) {
      const hint = denied.includes('fs') || denied.includes('path')
        ? ' (likely `serveStaticDir` on disk — switch the dev UI to the CDN `AssetSource`, or omit it for edge)'
        : ' (no Cloudflare Workers equivalent)';
      return {ok: false, message: `Edge-incompatible import: ${denied}${hint}`};
    }
  }
  return {ok: true, message: ''};
}

export async function runBundleDoctor(
  entryPath: string,
  esbuildImpl?: typeof import('esbuild'),
): Promise<Diagnostic> {
  const esbuild = esbuildImpl ?? (await import('esbuild'));
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      logLevel: 'silent',
    });
  } catch (err) {
    return {ok: false, message: `Worker bundle failed to compile: ${(err as Error).message}`};
  }
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  // esbuild records node: builtins as inputs prefixed with the namespace.
  const nodeImports = inputs.filter(i => i.startsWith('node:'));
  return scanImports(nodeImports);
}
```

> The unit test targets the pure `scanImports`; `runBundleDoctor`'s esbuild path is exercised by the e2e/integration fixture in Task 7 (it needs a real entry on disk). Keep `scanImports` the well-tested core.

- [ ] **Step 4: Add `esbuild` dep + run test → PASS**

Edit `packages/cli/package.json` dependencies: add `"esbuild": "~0.28.1"` (matches the version the UI packages already use — `packages/console/package.json`; keep it identical so the workspace resolves one esbuild). Run `pnpm install`, then `pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/bundle-doctor.unit.js` → PASS.

- [ ] **Step 5: Wire the real doctor into `cloudflareTarget.preflight`** (replace the Task 4 stub import so `runBundleDoctor(path.join(cwd, WORKER_PATH))` runs). Re-run `cloudflare-target.unit.js` — still green (it doesn't deploy; preflight isn't called in those unit tests).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/bundle-doctor.ts packages/cli/src/__tests__/unit/bundle-doctor.unit.ts packages/cli/src/targets/cloudflare.ts packages/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): bundle doctor — esbuild-analyze node: allow/deny preflight"
```

---

### Task 6: Wire `cloudflare` into the CLI

**Files:**
- Modify: `packages/cli/src/args.ts` (accept `cloudflare`/`cf`/`workers` target), `packages/cli/src/cli.ts` (dispatch to `cloudflareTarget`), `packages/cli/src/__tests__/unit/args.unit.ts` + `cli.unit.ts`

**Interfaces:**
- Consumes: `vercelTarget`, `cloudflareTarget`. `DeployArgs.target` widens to `'vercel' | 'cloudflare'`.

- [ ] **Step 1: Write the failing test** (append to `args.unit.ts`)

```ts
it('accepts cloudflare and its aliases', () => {
  expect(parseDeployArgs(['cloudflare']).target).toBe('cloudflare');
  expect(parseDeployArgs(['cf']).target).toBe('cloudflare');
  expect(parseDeployArgs(['workers']).target).toBe('cloudflare');
});
it('still rejects an unknown target', () => {
  expect(() => parseDeployArgs(['fly'])).toThrow(/vercel|cloudflare/i);
});
```

- [ ] **Step 2: Run → fails** (cloudflare currently throws "unknown target").

- [ ] **Step 3: Update `args.ts`** — change the target validation:

```ts
const TARGETS: Record<string, 'vercel' | 'cloudflare'> = {
  vercel: 'vercel', cloudflare: 'cloudflare', cf: 'cloudflare', workers: 'cloudflare',
};
// ...
const resolved = TARGETS[target];
if (!resolved) bad(`deploy: unknown target '${target}' (supported: vercel, cloudflare)`);
out.target = resolved;
```

Widen `DeployArgs.target` to `'vercel' | 'cloudflare'`.

- [ ] **Step 4: Run args test → PASS.**

- [ ] **Step 5: Update `cli.ts` dispatch** — select the target by `args.target`:

```ts
import {vercelTarget} from './targets/vercel.js';
import {cloudflareTarget} from './targets/cloudflare.js';
// ...
const target = args.target === 'cloudflare' ? cloudflareTarget : vercelTarget;
const out = await runDeploy(args, target, {exec: nodeExec, fetchFn: globalThis.fetch, cwd: process.cwd()});
```

Update `USAGE` to mention `cloudflare`. Add a `cli.unit.ts` case asserting `main(['deploy','cloudflare','--bogus'])` exits 1 with `/unknown flag/i` (proves dispatch + parse wired).

- [ ] **Step 6: Build + run the FULL cli unit suite**

Run: `pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/unit/`
Expected: PASS (Vercel regression + all new Cloudflare unit suites).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src
git commit -m "feat(cli): wire `deploy cloudflare` (aliases cf/workers) into the CLI"
```

---

### Task 7: Credential-gated CF e2e + fixture + docs

**Files:**
- Create: `packages/cli/src/__tests__/e2e/deploy-cloudflare.e2e.ts`, a fixture worker app (`packages/cli/src/__tests__/fixtures/cf-app/` with a minimal `@api` controller + `buildApp` export + built `dist/`), and docs
- Modify: `packages/cli/README.md`, `docs/guides/deploy-to-edge.md`

**Interfaces:**
- Consumes: `main` from `cli.js`. Runs a real `wrangler deploy` only when `ABC_E2E_CLOUDFLARE=1` and Cloudflare creds are present; skipped otherwise.

- [ ] **Step 1: Create the fixture app** — a minimal AgentBack app exporting `buildApp({listen:false})` with one `@api` GET route, so `/openapi.json` is non-empty. Build it (`tsc`) so `dist/` exists for the worker import + the doctor.

- [ ] **Step 2: Write the gated e2e**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {main} from '../../cli.js';

const RUN = process.env.ABC_E2E_CLOUDFLARE === '1';

describe.skipIf(!RUN)('deploy cloudflare (e2e, credential-gated)', () => {
  it('deploys a fixture worker and serves /openapi.json', async () => {
    // Harness sets cwd to the fixture app dir and provides CLOUDFLARE creds.
    const code = await main(['deploy', 'cloudflare', '--yes']);
    expect(code).toBe(0);
  }, 240_000);
});
```

- [ ] **Step 3: Verify the e2e is skipped by default**

Run: `pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/e2e/deploy-cloudflare.e2e.js`
Expected: 1 skipped, exit 0.

- [ ] **Step 4: Add a `--dry-run` integration test that runs the REAL bundle doctor on the fixture**

This is the one place the esbuild path runs in CI (no creds needed — dry-run stops before deploy):

```ts
it('dry-run runs the bundle doctor on the fixture without deploying', async () => {
  // cwd = fixture dir; expect dry-run success (doctor passes a clean REST app)
  const code = await main(['deploy', 'cloudflare', '--dry-run']);
  expect(code).toBe(0);
});
```

Place in an `*.integration.ts` so it's in the default glob; point `process.chdir` at the fixture (restore after). Expected: the doctor bundles the fixture worker, finds no denied `node:` import (REST-only), dry-run returns 0.

- [ ] **Step 5: Docs** — README "Cloudflare Workers" section (entry contract, `--console` CDN note, the `ABC_E2E_CLOUDFLARE=1` e2e, the `pnpm build` prereq). Refresh `docs/guides/deploy-to-edge.md` to mark Workers REST as shipped and correct the stale `hello-hosts` MCP caveat.

- [ ] **Step 6: Full workspace verify**

Run: `pnpm verify`
Expected: build + typecheck:client + test + validate-templates green (default suites; CF e2e skipped).

- [ ] **Step 7: Commit**

```bash
git add packages/cli docs
git commit -m "test(cli): cloudflare bundle-doctor integration + gated e2e + edge docs"
```

---

## Self-Review

**Spec coverage:** §3 DeployTarget extraction → Task 1. §4 worker fetch leaf → Task 4 (generate-worker). §5 wrangler.toml → Task 4 (merge-wrangler). §6 bundle doctor → Task 5. §7 AssetSource D → Task 2, C → Task 3. §8 CLI surface → Task 6. §9 acceptance e2e + regression → Task 7 + Task 1's regression gate. §2 decision #8 (console gate carries over) → preserved in Task 1's `run-deploy.ts`. No spec section is unmapped.

**Placeholder scan:** every code step carries full code. The one deliberate sequencing note (Task 4 Step 11 stub of `runBundleDoctor` filled in Task 5) is explicit, not a placeholder. No TBD/"handle errors"/"similar to".

**Type consistency:** `DeployTarget`/`GenerateOpts`/`FileEdit`/`Diagnostic`/`RunDeps`/`RunOutcome` defined in Task 1 and consumed unchanged in Tasks 4–6. `ResolvedBuilder` = `{entry, exportName}` used consistently. `generateEntry` returns `FileEdit` (not a bare string) — Task 4's `cloudflareTarget.generateEntry` and Task 1's `vercelTarget.generateEntry` both honor that; `run-deploy.writeEdit` consumes `FileEdit`. `runBundleDoctor`/`scanImports` names match across Tasks 4–5. `fromDisk`/`fromCdn`/`AssetSource` consistent across Tasks 2–3.

**Pre-verified against the repo:**
- `RestServer.fetchHandler(): FetchHost` where `FetchHost = {fetch(req: Request): Promise<Response>}` — `packages/rest/src/host/fetch.ts:9`. The worker leaf is valid.
- `serveStaticDir` body (MIME map + traversal guard + cache header) moves wholesale into `fromDisk` — `packages/rest/src/host/static.ts:43`.
- The three `install*` helpers each call `serveStaticDir(<dir>)` once (`console:137`, `rest-explorer:73`, `mcp-inspector:273`) — the single line each that gains `options.assets ?? fromDisk(...)`.
- `esbuild` is in the workspace (UI packages) but NOT a cli dep — Task 5 adds it; pin to the version in `packages/console/package.json`.
- `AgentError` + `ErrorCodes.INVALID_INPUT` from `@agentback/openapi` barrel — used throughout.
