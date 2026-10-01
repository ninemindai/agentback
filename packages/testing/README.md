# @agentback/testing

First-class test harness: boot an application with binding overrides on an
ephemeral port and get three clients back — a typed route client, raw
supertest, and an in-memory MCP session.

```ts
import {createTestApp} from '@agentback/testing';

await using t = await createTestApp(MyApplication, {
  overrides: {
    'datasources.db': fakeDb, // value override
    'services.Mailer': FakeMailer, // class override
  },
  mcpScopes: ['orders:read'], // scope-filtered MCP session
});

// 1. Typed — the same defineRoute handles your consumers use:
const order = await t.call(getOrder, {path: {id: '42'}});

// 2. Raw HTTP:
await t.http.get('/openapi.json').expect(200);

// 2b. In-process Web fetch (Workers/Bun/Deno surface), no socket:
const res = await t.fetch('/orders/42');

// 3. MCP — in-memory transport, no process or socket:
const tools = await t.mcp.listTools();

await t.stop(); // or rely on `await using`
```

### Tools that ask the user (elicitation)

`t.call()` and `MCPServer.callTool` run in-process and cannot answer an
`elicit.ask`, so they fail with `elicitation_unavailable`. Drive the tool
through `t.mcp` and answer from the test with `mcpElicit` (`mcpEra` picks the
protocol era; default is a 2025 `initialize`):

```ts
await using t = await createTestApp(MyApp, {
  mcpEra: 'modern',
  mcpElicit: ({message}) =>
    message.startsWith('Which part')
      ? {action: 'accept', content: {part: 'nut'}}
      : {action: 'decline'},
});
const r = await t.mcp.callTool({
  name: 'cad_inspect',
  arguments: {assembly: 'hinge'},
});
expect(r.structuredContent).toEqual({part: 'nut', ok: true});
```

The client answers each round and the tool re-runs with the answer, exactly
as against a real host. A `confirm:` prompt is answered by the same function
(`{action: 'accept', content: {confirm: true}}`).

Also exports `runInstallConformance(label, {makeApp, install, served, untouched})` —
the shared conformance suite for the
[revertible-install contract](../../docs/proposals/revertible-installs.md):
every migrated `install*` helper runs the same install → serve → uninstall →
404 cycle on both hosts (Express and the neutral fetch host), plus an
idempotent-uninstall check, so the contract cannot decay helper-by-helper.
Mirror of `@agentback/files/testing`'s `runFileStoreConformance`.

Notes:

- Overrides are applied **after** the app constructor — rebinding by key wins.
- The REST server is forced to `port: 0` (ephemeral) and MCP stdio is forced
  off, so tests never collide or grab stdin. Other config passes through
  `options.config[bindingKey]`.
- `t.mcp` exercises the same scope-filtered session building as an
  authenticated HTTP transport (`mcpScopes`), so `@authorize`-gated tool
  visibility is testable in-process.
- `t.fetch(path, init?)` runs the request through the app's runtime-neutral
  Web fetch handler (the Workers/Bun/Deno surface) in-process — a relative
  `path` resolves against `t.url`; a `Request` passes through. No socket.
- `@agentback/mcp` and the MCP SDK are optional peers — apps without an
  MCP server never load them; `t.mcp` throws a clear error instead.
