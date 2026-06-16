# Testing

How to test an AgentBack application: the harness, the four client
surfaces it hands you, and the conventions the workspace itself follows.

## The one rule: tests run against `dist/`

`vitest.config.ts` globs
`packages/*/dist/__tests__/**/*.{test,spec,unit,integration,acceptance}.js`.
Edit a `.ts` file → `pnpm build` (or keep `pnpm build:watch` running) →
`pnpm test`. If a change "isn't being picked up," this is why.

Naming conventions: `*.unit.ts` for tests of one module in isolation,
`*.integration.ts` for tests that boot servers, under
`src/__tests__/unit/` and `src/__tests__/integration/`.

## Gotcha: `TypeError: <name> is not a function` at a decorator line

Decorators live in specific packages — import them from the right one:

- REST verb decorators — `api`, `get`, `post`, `put`, `patch`, `del` — from **`@agentback/openapi`** (not `@agentback/rest`).
- MCP decorators — `mcpServer`, `tool`, `resource`, `prompt` — from **`@agentback/mcp`**.
- DI decorators — `injectable`, `inject` — from **`@agentback/context`**.

Import a decorator from the wrong package and it resolves to `undefined`, so
`@get(...)` throws `TypeError: get is not a function` the moment the class is
defined. Under `tsc` this is a clean compile error (`TS2305: has no exported
member 'get'`) — but if your project's test runner transforms `.ts` through
**esbuild/SWC** (Vitest, Vite, `tsx`), it does **not** type-check, so the same
mistake only surfaces at runtime as the confusing "not a function". If you hit
that, check the import source first. (AgentBack's decorators run correctly under
esbuild — it's the import, not the transform.)

## `createTestApp` — boot once, get every surface

`@agentback/testing` boots your real application class with test-safe
overrides: an ephemeral REST port, MCP stdio disabled, and your bindings
swapped where you need fakes.

```ts
import {createTestApp} from '@agentback/testing';
import {getOrder} from 'my-service/routes'; // a defineRoute/routeGroup handle

it('serves an order end to end', async () => {
  await using t = await createTestApp(MyApplication, {
    overrides: {[DB_KEY]: fakeDb}, // rebinding by key wins
  });

  const order = await t.call(getOrder, {path: {id: '42'}});
  expect(order.status).toBe('shipped'); // typed: z.infer of the response schema
});
```

`await using` (explicit resource management) stops the app when the block
exits — no `afterEach` bookkeeping. On runtimes without `await using`, call
`t.stop()` in a `finally`.

The returned `TestApp` carries four surfaces; pick the lowest one that can
express the assertion:

| Surface    | What it is                                          | Use for                                                |
| ---------- | --------------------------------------------------- | ------------------------------------------------------ |
| `t.call`   | typed route-handle execution (schema-shared client) | most behavior tests — input and output are `z.infer`ed |
| `t.client` | a `@agentback/client` Client at the test URL   | `safeCall`, custom handles, error-result shapes        |
| `t.http`   | raw supertest                                       | status codes, headers, malformed-input cases           |
| `t.mcp`    | in-memory MCP SDK client                            | tool/resource/prompt behavior, visibility, envelopes   |
| `t.app`    | the application (a `Context`)                       | DI assertions: `t.app.getSync(KEY)`                    |

Examples of the non-typed surfaces:

```ts
// Wire-level: assert the agent error envelope on a validation failure.
const r = await t.http.post('/orders').send({}).expect(422);
expect(r.body.error.code).toBe('invalid_body');

// MCP: same process, no transport, real dispatch pipeline.
const result = await t.mcp.callTool({name: 'get_order', arguments: {id: '42'}});
expect(result.isError).toBeFalsy();
```

## Testing the policy layer

`mcpScopes` builds the in-memory MCP session exactly like an authenticated
HTTP session, so scope-gated visibility is testable without standing up
OAuth:

```ts
await using t = await createTestApp(MyApp, {mcpScopes: ['orders:read']});
const {tools} = await t.mcp.listTools();
expect(tools.map(x => x.name)).not.toContain('refund_order'); // needs orders:write
```

For REST auth, drive the real strategies through `t.http` with real
headers — the test app runs the same authenticate → authorize → validate
pipeline as production.

## Overriding configuration

`configurations` merges over whatever the app configured per binding key:

```ts
await using t = await createTestApp(MyApplication, {
  configurations: {
    'servers.RestServer': {basePath: '/api'},
    'servers.MCPServer': {name: 'test-server'},
  },
});
```

(The harness always forces `port: 0` and `transports: {stdio: false}` on top
— tests must not grab fixed ports or hijack stdio.)

## What to test at which level

- **Unit**: pure logic, decorators' metadata, a hook's behavior with a fake
  `info` object. No app boot. Fast enough to run on every save.
- **Integration** (`createTestApp`): the contract — routes validate and
  serialize as declared, tools appear/disappear by scope, error envelopes
  carry the right `code`. This is where boundary coherence pays off: shape
  mistakes are already impossible by compile time or startup, so these tests
  assert _behavior_, not bookkeeping.
- **Don't test the framework**: re-asserting that Zod validates or that
  OpenAPI emits is the workspace's job (2,000+ tests here). Your tests own
  your handlers' behavior.

One startup behavior worth relying on instead of testing: URL placeholders
are cross-checked against `path:` schemas at `app.start()` — so a single
"the app boots" integration test catches every route/schema mismatch in the
codebase at once.

## Testing time, randomness, and queues

- Stores and meters take injectable clocks/id generators
  (`MeterOptions.now/genId`) — bind deterministic ones rather than sleeping.
- The in-memory messaging adapter (`@agentback/messaging`) runs jobs
  and events in-process; integration tests can await a job's completion
  without Redis. The BullMQ adapter has its own conformance suite that runs
  only when `REDIS_URL` is present — follow that pattern for tests needing
  external services: skip, don't mock the world.
