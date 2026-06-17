# @agentback/cli

AgentBack CLI — deploy an AgentBack app to Vercel (and more targets in future tasks).

## Usage

```bash
agentback deploy vercel [options]
```

Run `agentback deploy vercel --help` for the full option list (available in a later task).

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
```

## End-to-end testing

A credential-gated e2e test (`packages/cli/src/__tests__/e2e/deploy-vercel.e2e.ts`) runs real Vercel deployments when enabled. It is **skipped by default** and does not run in CI without explicit opt-in.

To run the e2e test locally:

1. Link a Vercel project to your fixture app directory (or set `VERCEL_PROJECT_ID` + `VERCEL_ORG_ID` env vars for the test fixture).
2. Ensure Vercel CLI credentials are available (`vercel whoami` should work).
3. Set the opt-in flag and run the test:

```bash
ABC_E2E_VERCEL=1 pnpm -F @agentback/cli exec vitest run packages/cli/dist/__tests__/e2e/deploy-vercel.e2e.js
```

The test deploys a fixture app and verifies that the deployment succeeds and `/openapi.json` is reachable. It times out after 3 minutes if the deploy does not complete.
