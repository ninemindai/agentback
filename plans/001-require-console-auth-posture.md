# Plan 001: Require an explicit auth posture for the unified console

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 3acdb66..HEAD -- packages/console/src/index.ts packages/console/src/__tests__/integration/console.integration.ts packages/mcp-inspector/src/index.ts packages/mcp-inspector/src/__tests__/integration/inspector.integration.ts packages/mcp-connect/src/index.ts packages/mcp-connect/src/__tests__/integration/connect.integration.ts packages/console/README.md packages/mcp-inspector/README.md packages/mcp-connect/README.md`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `3acdb66`, 2026-06-11

## Why this matters

`@agentback/console` composes the context explorer, OpenAPI explorer, MCP
inspector, and remote MCP connection manager. Those surfaces expose DI binding
metadata and allow server-side outbound MCP connections. Today `installConsole`
has an optional `auth` middleware but defaults to no auth, while the default MCP
panel enables remote-connect. This plan makes the auth posture explicit so a
production deployment cannot accidentally publish the sensitive console without
choosing either an auth gate or a clearly named unsafe development mode.

## Current state

- `packages/console/src/index.ts` mounts built-in console features. It accepts
  `ConsoleOptions.auth`, but no default guard is applied.
- `packages/mcp-inspector/src/index.ts` defines `mcpConsoleFeature`; its
  current default enables remote-connect.
- `packages/mcp-connect/src/index.ts` mounts raw Express APIs for adding remote
  targets and proxying tool/resource/prompt calls.
- `packages/console/src/__tests__/integration/console.integration.ts` already
  tests that an explicitly supplied auth middleware gates the UI and APIs.

Relevant excerpts at plan time:

```ts
// packages/console/src/index.ts:40
 * Optional auth middleware. When set, it gates the console UI **and** the
 * aggregated panel APIs (each feature's `apiBase`, plus any mcp-connect base).
 * Default none — but the console aggregates sensitive surfaces (DI internals,
 * outbound MCP connections), so production deployments should set it.
```

```ts
// packages/console/src/index.ts:52
export function defaultFeatures(): ConsoleFeature[] {
  return [contextConsoleFeature(), apiConsoleFeature(), mcpConsoleFeature()];
}
```

```ts
// packages/mcp-inspector/src/index.ts:218
const connectOpt = options.connect ?? true; // remote-connect on by default
```

```ts
// packages/mcp-connect/src/index.ts:68
expressApp.get(`${api}/targets`, (_req, res) => res.json(registry.list()));
expressApp.post(`${api}/targets`, json, async (req: Request, res: Response) => {
  const {url, auth} = (req.body ?? {}) as {url?: string; auth?: AuthConfig};
  if (!url) return fail(res, 400, 'Missing "url"');
  const redirectUri = `${req.protocol}://${req.get('host')}${path}/oauth/callback`;
  ...
});
```

Existing test pattern:

```ts
// packages/console/src/__tests__/integration/console.integration.ts:112
it('gates the UI and the aggregated APIs without the key', async () => {
  await g.get('/console').expect(401);
  await g.get('/mcp-inspector/api/manifest').expect(401);
  await g.get('/context-explorer/api/bindings').expect(401);
  await g.get('/mcp-connect/api/targets').expect(401);
});
```

Repo conventions to follow:

- TypeScript ESM, NodeNext imports with `.js` only for local runtime imports
  where already used.
- Source files carry the existing copyright header; do not change headers.
- Test files use Vitest + Supertest, matching the existing integration test
  structure.
- Keep API names plain and explicit. Prefer one option such as
  `unsafeAllowUnauthenticated?: boolean` over hidden environment checks.

## Commands you will need

| Purpose        | Command                                                                                                                                                                                                                                     | Expected on success     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Build          | `pnpm build`                                                                                                                                                                                                                                | exit 0                  |
| Targeted tests | `pnpm exec vitest run packages/console/dist/__tests__/integration/console.integration.js packages/mcp-inspector/dist/__tests__/integration/inspector.integration.js packages/mcp-connect/dist/__tests__/integration/connect.integration.js` | all selected tests pass |
| Full tests     | `pnpm test`                                                                                                                                                                                                                                 | exit 0                  |
| Lint           | `pnpm lint`                                                                                                                                                                                                                                 | exit 0                  |

Important: this repo's Vitest config runs tests from built `dist`. Run
`pnpm build` before any `pnpm exec vitest run ...dist...` command.

## Scope

**In scope**:

- `packages/console/src/index.ts`
- `packages/console/src/__tests__/integration/console.integration.ts`
- `packages/console/README.md`
- `packages/mcp-inspector/src/index.ts` only if needed to keep default
  remote-connect behavior coherent with the console auth posture
- `packages/mcp-inspector/src/__tests__/integration/inspector.integration.ts`
  only if you change `mcpConsoleFeature`
- `packages/mcp-inspector/README.md` only if you change public options
- `packages/mcp-connect/src/index.ts` only if you add reusable auth middleware
  support at the lower-level mount
- `packages/mcp-connect/src/__tests__/integration/connect.integration.ts` only
  if you change `mcp-connect`
- `packages/mcp-connect/README.md` only if you change public options

**Out of scope**:

- Rewriting the console UI.
- Adding a built-in login/session system.
- Changing context-explorer or REST explorer data shapes.
- Changing SSRF behavior in `mcp-connect`; the existing private-address guard
  is not the finding.

## Git workflow

- Branch: `advisor/001-console-auth-posture`
- Commit message style: conventional commits. Recent examples include
  `feat(metering): dispatch hooks replace the server subclasses` and
  `fix(deps): drizzle-orm ^0.45.2 — SQL injection in identifier escaping`.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Add an explicit unsafe opt-in to `installConsole`

Change `ConsoleOptions` so unauthenticated console mounting requires an explicit
development-only option. Recommended shape:

```ts
/**
 * Explicitly allow mounting the console without server-side auth.
 * Unsafe outside local development.
 */
unsafeAllowUnauthenticated?: boolean;
```

In `installConsole`, before feature installation, enforce:

- If `options.auth` is provided, behave exactly as today.
- If `options.auth` is absent and `options.unsafeAllowUnauthenticated !== true`,
  throw an error with a message that names both choices:
  provide `auth`, or pass `unsafeAllowUnauthenticated: true` for local
  development.
- If `unsafeAllowUnauthenticated: true`, continue with today's behavior.

Keep the existing auth middleware ordering: it must still be registered before
features register their routes.

**Verify**: `pnpm build` -> exit 0.

### Step 2: Update console integration tests

Modify `packages/console/src/__tests__/integration/console.integration.ts`:

- Update the helper `makeApp` to pass `unsafeAllowUnauthenticated: true` when
  no auth middleware is supplied.
- Add a new test that constructing/installing the console without `auth` and
  without `unsafeAllowUnauthenticated` rejects before `app.start()`.
- Keep the existing auth-gate tests, and ensure they still prove `/console`,
  `/mcp-inspector/api/manifest`, `/context-explorer/api/bindings`, and
  `/mcp-connect/api/targets` return 401 without the key.

**Verify**:
`pnpm build && pnpm exec vitest run packages/console/dist/__tests__/integration/console.integration.js`
-> all tests in that file pass.

### Step 3: Decide whether standalone inspector/connect need the same posture

Review `installInspector(app, {connect: true})` and `installMcpConnect(app)`.
If the standalone APIs are documented as lower-level building blocks rather
than a bundled admin console, do not force auth there in this plan. If you find
the same accidental-production default in docs or tests, add a matching explicit
unsafe option there too, but only if the change stays small.

Minimum requirement for this plan: the default unified console must no longer
mount unauthenticated by omission.

**Verify**:
`pnpm build && pnpm exec vitest run packages/mcp-inspector/dist/__tests__/integration/inspector.integration.js packages/mcp-connect/dist/__tests__/integration/connect.integration.js`
-> pass if you touched those packages; otherwise this command may be skipped
and noted.

### Step 4: Update docs for the new option

Update `packages/console/README.md` with:

- A secure default example using `auth`.
- A local-development example using `unsafeAllowUnauthenticated: true`.
- A short note that the default panels include DI inspection and remote MCP
  connection management, so production deployments should gate the console.

If you changed `mcp-inspector` or `mcp-connect` public options, update their
READMEs similarly.

**Verify**: `pnpm lint` -> exit 0.

## Test plan

- Add one regression test in `packages/console/src/__tests__/integration/console.integration.ts`
  for the new default refusal.
- Keep existing positive coverage for unauthenticated local mode by opting in
  with `unsafeAllowUnauthenticated: true`.
- Keep existing positive coverage for explicit auth middleware.

## Done criteria

- [ ] `installConsole(app)` without `auth` and without
      `unsafeAllowUnauthenticated: true` throws a clear configuration error.
- [ ] `installConsole(app, {unsafeAllowUnauthenticated: true})` preserves the
      current local-dev behavior.
- [ ] `installConsole(app, {auth})` still gates UI and aggregated APIs.
- [ ] Targeted console integration tests pass from `dist`.
- [ ] `pnpm build`, `pnpm test`, and `pnpm lint` exit 0.
- [ ] `git diff --stat` shows no files outside this plan's in-scope list.

## STOP conditions

Stop and report if:

- Existing code no longer matches the excerpts above.
- Enforcing the new default requires changing public APIs outside the console,
  inspector, or connect packages.
- You discover a current production example that intentionally calls
  `installConsole(app)` without auth and would break without an obvious
  migration path.
- Verification fails twice after a reasonable fix attempt.

## Maintenance notes

Reviewers should scrutinize route ordering. The auth middleware must still be
mounted before feature APIs. Future console panels that expose sensitive APIs
must advertise their API base in `ConsoleFeature.apiBase` and any extra remote
base in `extra.connect.base` so the console auth gate covers them.
