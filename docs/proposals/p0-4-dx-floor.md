# Proposal P0-4: The DX Floor — Testing Module + `create-agentback`

**Status:** Implemented (2026-06-10); `npm create` UX gated on publish pipeline.
**Packages touched:** new `testing` package, new `create-agentback` package, `testlab` (reused).

## Motivation

Adoption blockers, not architecture. FastAPI wins developers in the first ten
minutes (`pip install`, instant docs); NestJS's most-praised DX feature is
`Test.createTestingModule`. Today AgentBack requires cloning a monorepo,
and testing an app means hand-rolling supertest against a started server.
The DI container makes both gaps cheap to close.

## Part A: `@agentback/testing`

### API

```ts
import {createTestApp} from '@agentback/testing';

const t = await createTestApp(MyApplication, {
  overrides: {
    [DB_KEY]: fakeDb,                  // value override
    'services.Mailer': FakeMailer,     // class override
  },
  config: {rest: {port: 0}},           // ephemeral port by default
});

// 1. Typed client — reuses @agentback/client route handles
const res = await t.call(getOrder, {path: {id: '42'}});

// 2. Raw HTTP — supertest, for header/status-level assertions
await t.http.get('/openapi.json').expect(200);

// 3. MCP — in-memory transport, no process or socket
const tools = await t.mcp.listTools();
const out = await t.mcp.callTool({name: 'create_order', arguments: {...}});

await t.stop();
```

### Semantics

- `createTestApp(AppClass | factory, opts)` instantiates the app, applies
  `overrides` **after** the constructor runs (rebinding wins because
  `Context.bind` replaces by key), boots and starts on port 0.
- `t.client` is a `@agentback/client` `Client` pointed at the ephemeral
  base URL; `t.call(handle, input)` = `handle.call(t.client, input)` —
  the same `defineRoute` handles an app's consumers use, so tests exercise
  the real serialization path and double as client-contract tests.
- `t.http` wraps `createRestAppClient` from `testlab` (supertest).
- `t.mcp`: when the app has `MCPBindings.SERVER` bound, build a per-test SDK
  server via `mcp.buildServer()` and connect it to the SDK's
  `InMemoryTransport` pair with an SDK `Client` on the other end. Optional
  `mcpScopes` in options exercises scope-filtered sessions (pairs with P0-1).
- `t.app` exposes the application for direct `ctx.get` assertions.
- `stop()` is idempotent and also runs on vitest teardown via
  `Symbol.asyncDispose` (`await using t = …`). Requires adding
  `esnext.disposable` to `lib` in `tsconfig.base.json` (and templates) —
  the current `es2022` lib has no `Symbol.asyncDispose` typing.

### Why a new package (not `testlab`)?

`testlab` is the ported low-level toolbox (shot stubs, sandbox, sinon) and
stays dependency-light. `testing` depends on `core`, `rest`, `client`, `mcp`,
and the MCP SDK — a heavyweight composition layer that would pollute
`testlab`'s dependents. `testing` imports from `testlab` where useful.
`mcp` (and the SDK) is a peer/optional dependency — `t.mcp` lazily
initializes and throws a clear error if the app has no MCP server bound.

## Part B: `create-agentback`

### Shape

```bash
npm create agentback@latest my-service          # default: hybrid
npm create agentback@latest my-api -- --template rest
npm create agentback@latest my-tools -- --template mcp
```

> **Review note — publish prerequisite (critical):** the workspace packages
> are versioned locally but unpublished; `npm create agentback@latest` is dead on
> arrival until a release/publish pipeline exists. This proposal **builds**
> the scaffold and templates now (validated in CI via `pnpm pack` tarballs)
> but the `npm create` UX activates at first publish. The publish pipeline
> (versioning, provenance, registry CI job) is a separate prerequisite
> proposal — explicitly NOT in scope here, tracked so it can't silently drop.

- A small bin package (`create-agentback`, not `@agentback/`-scoped
  — `npm create` requires the `create-` prefix resolution).
- Templates are embedded directories (`templates/{rest,mcp,hybrid}`), copied
  with `{{name}}` substitution in `package.json`/README. No network fetch, no
  prompt library; one positional arg + `--template` + `--pm` detection
  (pnpm/npm/yarn via `npm_config_user_agent`).
- Each template is a **standalone app** (not a workspace): `package.json`
  pins published `@agentback/*` versions, `tsconfig.json` (NodeNext,
  ESM), `src/application.ts`, one controller with a Zod schema, vitest
  config that **tests against `src` via tsx** (single-package apps don't need
  the monorepo's dist-test rule), and a `src/__tests__` using
  `@agentback/testing`. Two esbuild-regime caveats baked into templates:
  every entry imports `reflect-metadata` first, and the template CI leg runs
  the template's _tests_ (not just build) so the
  esbuild-without-`emitDecoratorMetadata` path stays covered — it works only
  because `@inject` never relies on design types (the P0-3 premise), and CI
  should fail loudly if that ever regresses.
- Hybrid template = REST + MCP from one process with `/explorer` and
  `/mcp-inspector` mounted — the framework's signature demo, generated.
- Templates are validated in CI: a workflow job scaffolds each template into
  a temp dir against `workspace:*` packed tarballs and runs its build+test.

### Out of scope (deliberately)

- Generators (`add controller`, `add tool`) — follow-up once the plugin
  manifest conventions settle; the scaffold is the adoption-critical piece.
- Interactive TUI prompts — flags only; agents and humans both prefer it.

## Implementation plan

1. `packages/testing`: `createTestApp`, typed-call helper, supertest bridge,
   in-memory MCP client; unit + acceptance tests (override wins, ephemeral
   port, MCP tool call end-to-end).
2. `packages/create-agentback`: bin + three templates + copy/substitute
   logic; self-test that scaffolds into a temp dir and type-checks the output.
3. Root README quick-start gains the `npm create` path.
