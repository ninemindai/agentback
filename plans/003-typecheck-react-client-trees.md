# Plan 003: Typecheck React client trees and gate the check in CI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 3acdb66..HEAD -- package.json .github/workflows/ci.yml packages/console/package.json packages/console/tsconfig.json packages/console/build-client.mjs packages/console/src/client packages/context-explorer/package.json packages/context-explorer/tsconfig.json packages/context-explorer/build-client.mjs packages/context-explorer/src/client packages/mcp-inspector/package.json packages/mcp-inspector/tsconfig.json packages/mcp-inspector/build-client.mjs packages/mcp-inspector/src/client`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S/M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `3acdb66`, 2026-06-11

## Why this matters

The repo has three React client trees: console, context-explorer, and
mcp-inspector. Each package excludes `src/client` from its TypeScript project
and relies on esbuild to bundle TSX. esbuild catches syntax and bundling errors
but does not perform semantic TypeScript checking. This plan adds an explicit
client typecheck command and gates it in CI so UI type regressions cannot pass
build/test by accident.

## Current state

- Root `pnpm build` runs `tsc -b` and then all `build:client` scripts.
- CI runs install, build, and test, but not lint or a dedicated client
  typecheck.
- Client TSX is excluded from package `tsconfig.json` files.
- The client build scripts explicitly say esbuild is the sole compiler for TSX.

Relevant excerpts at plan time:

```json
// package.json:12
"scripts": {
  "build": "tsc -b && pnpm -r run build:client",
  "build:watch": "tsc -b --watch",
  "clean": "tsc -b --clean && pnpm -r exec rm -rf dist",
  "test": "vitest run",
  "test:watch": "vitest",
  "lint": "eslint . && prettier --check \"**/*.{ts,json,md}\""
}
```

```yaml
# .github/workflows/ci.yml:58
- name: Build
  run: pnpm build

- name: Test
  run: pnpm test
```

```json
// packages/console/tsconfig.json:8
"include": ["src/**/*"],
"exclude": ["dist", "node_modules", "src/client"]
```

```js
// packages/console/build-client.mjs:3
// src/client is excluded from tsconfig.json, so esbuild is the sole compiler
// for the TSX
```

The same exclude/build-client pattern exists in:

- `packages/context-explorer/tsconfig.json`
- `packages/context-explorer/build-client.mjs`
- `packages/mcp-inspector/tsconfig.json`
- `packages/mcp-inspector/build-client.mjs`

Client source roots:

- `packages/console/src/client`
- `packages/context-explorer/src/client`
- `packages/mcp-inspector/src/client`

Repo conventions to follow:

- Keep server/library `tsconfig.json` behavior stable; do not accidentally emit
  client files into `dist` through `tsc`.
- Prefer `tsc --noEmit` for typecheck-only scripts.
- Package scripts use concise names like `build:client`.
- The project uses pnpm workspaces and TypeScript project references.

## Commands you will need

| Purpose              | Command                 | Expected on success  |
| -------------------- | ----------------------- | -------------------- |
| Build                | `pnpm build`            | exit 0               |
| New client typecheck | `pnpm typecheck:client` | exit 0, no TS errors |
| Full tests           | `pnpm test`             | exit 0               |
| Lint                 | `pnpm lint`             | exit 0               |

## Scope

**In scope**:

- `package.json`
- `.github/workflows/ci.yml`
- `packages/console/package.json`
- `packages/console/tsconfig.json`
- new `packages/console/tsconfig.client.json` if needed
- `packages/console/build-client.mjs` comment only if it becomes stale
- `packages/context-explorer/package.json`
- `packages/context-explorer/tsconfig.json`
- new `packages/context-explorer/tsconfig.client.json` if needed
- `packages/context-explorer/build-client.mjs` comment only if it becomes stale
- `packages/mcp-inspector/package.json`
- `packages/mcp-inspector/tsconfig.json`
- new `packages/mcp-inspector/tsconfig.client.json` if needed
- `packages/mcp-inspector/build-client.mjs` comment only if it becomes stale
- `packages/*/src/client/**` only for real TypeScript errors exposed by the new
  check

**Out of scope**:

- UI redesign or behavior changes.
- Replacing esbuild.
- Moving client code into emitted server package declarations unless necessary.
- Adding new dependencies unless TypeScript cannot typecheck React TSX without
  them.

## Git workflow

- Branch: `advisor/003-client-typecheck`
- Commit message style: conventional commits, e.g.
  `test(console): typecheck client bundles in CI`.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Add per-package client tsconfigs

For each UI package, add a dedicated no-emit client TypeScript config:

- `packages/console/tsconfig.client.json`
- `packages/context-explorer/tsconfig.client.json`
- `packages/mcp-inspector/tsconfig.client.json`

Recommended shape:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "jsx": "react-jsx",
    "rootDir": ".",
    "tsBuildInfoFile": "./tsconfig.client.tsbuildinfo"
  },
  "include": ["src/client/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

If extending the package tsconfig inherits settings that make this impossible,
create a minimal config extending `../../tsconfig.base.json` instead and add
the package's normal source dependencies through imports. Keep `noEmit: true`.

**Verify**:
`pnpm -F @agentback/console exec tsc -p tsconfig.client.json --noEmit`
-> exit 0 or shows real TS errors to fix in Step 3.

### Step 2: Add package and root scripts

In each UI package `package.json`, add:

```json
"typecheck:client": "tsc -p tsconfig.client.json --noEmit"
```

In root `package.json`, add:

```json
"typecheck:client": "pnpm -r --if-present run typecheck:client"
```

Keep existing scripts unchanged except for adding this new command. Do not make
`build` depend on the new typecheck unless you have a strong reason; CI will
run it explicitly.

**Verify**: `pnpm typecheck:client` -> exit 0 or shows real TS errors to fix in
Step 3.

### Step 3: Fix real client type errors only

If `pnpm typecheck:client` reports errors, fix the minimal client code needed.
Stay inside `packages/console/src/client`, `packages/context-explorer/src/client`,
and `packages/mcp-inspector/src/client`.

Do not change runtime behavior unless the type error exposes an actual bug.
Common expected fixes:

- Add explicit event types.
- Narrow `unknown`.
- Adjust React prop types.
- Avoid relying on esbuild-only implicit `any`.

**Verify**: `pnpm typecheck:client` -> exit 0.

### Step 4: Gate client typecheck in CI

In `.github/workflows/ci.yml`, add a step after Build and before Test in both
jobs if appropriate:

```yaml
- name: Typecheck client bundles
  run: pnpm typecheck:client
```

The `templates` job does not need the client typecheck unless the root command
is cheap and dependencies are already present. Prefer adding it to the main
matrix job first. If adding it to templates adds no cost or flake risk, adding
it there is acceptable.

**Verify**: inspect the YAML and run `pnpm typecheck:client` locally.

### Step 5: Run full verification

Run:

```bash
pnpm build
pnpm typecheck:client
pnpm test
pnpm lint
```

Expected: all exit 0.

## Test plan

This is a tooling plan. No new Vitest tests are required. The regression test
is the new `pnpm typecheck:client` command, plus the CI workflow step that runs
it.

## Done criteria

- [ ] Each React client tree is covered by `tsc --noEmit`.
- [ ] Root `pnpm typecheck:client` runs all present package checks.
- [ ] CI runs `pnpm typecheck:client` in the main build/test workflow.
- [ ] `pnpm build`, `pnpm typecheck:client`, `pnpm test`, and `pnpm lint` exit 0.
- [ ] Any client source changes are minimal type fixes, not redesigns.
- [ ] `git diff --stat` shows no files outside this plan's in-scope list.

## STOP conditions

Stop and report if:

- Typechecking requires broad UI rewrites rather than small type fixes.
- The new configs cause `tsc` to emit files or alter the existing package
  declaration output.
- The package dependency graph needs new runtime dependencies.
- Verification fails twice after a reasonable fix attempt.

## Maintenance notes

Future UI packages should add their own `typecheck:client` script. Keep esbuild
as the bundler; this plan only adds semantic checking. Reviewers should confirm
that `tsconfig.client.json` has `noEmit: true` and does not accidentally include
server-only test files.
