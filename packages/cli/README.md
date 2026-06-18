# @agentback/cli

AgentBack CLI — deploy an AgentBack app to Vercel or Cloudflare Workers.

## Usage

```bash
agentback deploy vercel [options]
agentback deploy cloudflare [options]
```

Run `agentback deploy --help` for the full option list.

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

### Dry-run integration test

A non-credential integration test (`packages/cli/src/__tests__/integration/deploy-cloudflare.integration.ts`) runs the full generate + preflight pipeline against the fixture app in dry-run mode (no `wrangler` invocation). This test runs in CI.

```bash
pnpm -F @agentback/fixture-cf-app build && pnpm -F @agentback/cli build && \
  pnpm exec vitest run packages/cli/dist/__tests__/integration/deploy-cloudflare.integration.js
```
