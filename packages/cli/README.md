# @agentback/cli

The AgentBack **lifecycle** CLI — scaffold an app, deploy it, upgrade it across
a breaking release. Bins: `agentback` and the short alias `abc`.

> Not `@agentback/command`, which turns an app's own `@tool` classes into a
> command surface. That makes _your app_ a CLI; this is a CLI that acts _on_
> your app.

## Usage

```bash
agentback new my-service [--template hybrid|rest|mcp] [--with drizzle,auth]
agentback deploy vercel [options]
agentback deploy cloudflare [options]
agentback update [--to <version>] [--dry-run] [--force]
agentback --version
```

Run `agentback <command> --help` for the full option list. Exit codes: `0`
success, `1` failure — migration notes are advisory and do not change it.

## `new`

Delegates to `create-agentback`'s `scaffold()`; templates are never duplicated,
and `npm create agentback` keeps working unchanged. Deliberately
non-interactive — for the wizard, run `npm create agentback`.

## `deploy`

generate → preflight (bundle doctor) → platform CLI → verify `/openapi.json`.
`--dry-run` stops after preflight; `--eject` writes the platform files and
stops; `--temporary` (Cloudflare) deploys to a throwaway preview account with no
signup, and works only when unauthenticated.

## `update`

Four phases: **resolve** the app's current version from its `@agentback/*`
ranges → **migrate** (every entry in the half-open window `(from, to]`) →
**bump + install** → **audit**.

**Workspaces are covered.** Every phase walks the whole topology — pnpm
`packages:` globs and npm/yarn `workspaces`: sub-package pins get bumped, their
`src/**` gets scanned by the advisories, and `pnpm-workspace.yaml` `overrides`
(plus `catalog`, and package.json `overrides`/`resolutions`) get rewritten. An
override left behind silently re-pins every range the bump just moved. Detection
globs `<pkg>/src/**` only, per package — code kept outside `src/` is not
scanned.

```bash
npx @agentback/cli@latest update --dry-run
npx @agentback/cli@latest update
```

Run it through `npx`. This package is lockstep-versioned, so the copy installed
in a `0.9` app cannot contain the `0.9 → 0.10` migrations — those ship with
`0.10`. The CLI refuses when it is older than its target and prints this
invocation.

A migration is a **codemod** or an **advisory**: most breaking changes cannot be
transformed (a default flipping, a header no longer existing), so an advisory
reports what changed and what to do, with `file:line` where it can. As of
`0.9.0`: three advisories, zero codemods.

Migrations run **before** the bump, so a failed install cannot leave the app on
a version whose migrations never ran. Git is the undo mechanism — `update`
refuses a dirty tree unless `--force`.

The **audit** runs after the install and is the one thing here that can change
the exit code: it re-derives what is on disk (a filesystem walk for manifests, a
deep scan for pins, and the installed `node_modules` versions) and **exits 1**
listing every site where an `@agentback/*` still resolves below the target.
Deliberately built from different parts than the bump — a net woven from the
same enumeration cannot catch that enumeration's own blind spots.

## Binaries

- `agentback` — full name
- `abc` — short alias

## Installation

```bash
npm install -g @agentback/cli
```

Or use it via `npx`:

```bash
npx @agentback/cli deploy vercel
npx @agentback/cli deploy cloudflare
```

## Cloudflare Workers

The `deploy cloudflare` command (also aliased as `deploy cf` and `deploy workers`) generates a Cloudflare Workers entry file and a `wrangler.toml`, runs the bundle doctor to verify the built app has no denied `node:` imports, then deploys via `wrangler deploy`.

Prerequisites:

1. Install wrangler: `npm install -g wrangler`
2. Authenticate: `wrangler login`
3. Build your AgentBack app: `pnpm build`

Deploy a preview:

```bash
agentback deploy cloudflare
```

Deploy to production:

```bash
agentback deploy cloudflare --prod
```

Dry-run (generate + preflight only, skip deploy):

```bash
agentback deploy cloudflare --dry-run
```

Eject (write files, stop before deploy so you can customise):

```bash
agentback deploy cloudflare --eject
```

Deploy to a **throwaway preview account** — no Cloudflare signup, account, or token. Wrangler provisions a temporary account on the fly (via proof-of-work), deploys, and prints a claim URL; the deployment expires after 60 minutes unless claimed:

```bash
agentback deploy cloudflare --temporary
```

`--temporary` only works **unauthenticated** — wrangler refuses it when you are logged in or `CLOUDFLARE_API_TOKEN` is set. This makes it ideal for CI smoke-tests that deploy without storing any Cloudflare secret. Requires wrangler ≥ 4.102 (the flag is undocumented/hidden but accepted).

The generated worker entry is written to `.agentback/deploy/cloudflare/worker.ts`. It boots your `buildApp` function at cold-start and forwards every request to `server.fetchHandler()` — no Node-only APIs in the request path.

## End-to-end testing

### Vercel e2e

A credential-gated e2e test (`packages/cli/src/__tests__/e2e/deploy-vercel.e2e.ts`) runs real Vercel deployments when enabled. It is **skipped by default** and does not run in CI without explicit opt-in.

To run the Vercel e2e test locally:

1. Link a Vercel project to your fixture app directory (or set `VERCEL_PROJECT_ID` + `VERCEL_ORG_ID` env vars for the test fixture).
2. Ensure Vercel CLI credentials are available (`vercel whoami` should work).
3. Set the opt-in flag and run the test:

```bash
ABC_E2E_VERCEL=1 pnpm -F @agentback/cli build && pnpm exec vitest run packages/cli/dist/__tests__/e2e/deploy-vercel.e2e.js
```

### Cloudflare Workers e2e

A credential-gated e2e test (`packages/cli/src/__tests__/e2e/deploy-cloudflare.e2e.ts`) runs a real Cloudflare Workers deployment when enabled. It is **skipped by default** and does not run in CI without explicit opt-in.

To run the Cloudflare e2e test locally:

1. Install and authenticate wrangler (`wrangler whoami` must pass).
2. Set `CLOUDFLARE_API_TOKEN` (or use `wrangler login`).
3. Build the fixture app: `pnpm -F @agentback/fixture-cf-app build`
4. Set the opt-in flag and run the test from the fixture directory:

```bash
ABC_E2E_CF=1 pnpm -F @agentback/cli build && \
  cd packages/cli/fixtures/cf-app && \
  pnpm exec vitest run ../../dist/__tests__/e2e/deploy-cloudflare.e2e.js
```

The test deploys the fixture app and verifies the deployment succeeds. It times out after 3 minutes if the deploy does not complete.

### Cloudflare Workers e2e — secretless (`--temporary`)

A second variant (same file, gated on `ABC_E2E_CF_TEMP=1`) deploys via `--temporary`, so it needs **no `CLOUDFLARE_API_TOKEN`**. It must run **unauthenticated** — wrangler refuses `--temporary` when a session or token is present. CI runners are unauthenticated by default; to run locally, isolate wrangler's home so it can't see your session:

```bash
ABC_E2E_CF_TEMP=1 pnpm -F @agentback/cli build && \
  cd packages/cli/fixtures/cf-app && \
  env -u CLOUDFLARE_API_TOKEN HOME=$(mktemp -d) \
    PATH="../../node_modules/.bin:$PATH" \
    pnpm exec vitest run ../../dist/__tests__/e2e/deploy-cloudflare.e2e.js
```

The temporary-account endpoint is anonymous and may rate-limit, so keep this **non-blocking** in CI rather than a required check.

### Dry-run integration test

A non-credential integration test (`packages/cli/src/__tests__/integration/deploy-cloudflare.integration.ts`) runs the full generate + preflight pipeline against the fixture app in dry-run mode (no `wrangler` invocation). This test runs in CI.

```bash
pnpm -F @agentback/fixture-cf-app build && pnpm -F @agentback/cli build && \
  pnpm exec vitest run packages/cli/dist/__tests__/integration/deploy-cloudflare.integration.js
```
