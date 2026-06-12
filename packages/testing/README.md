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

// 3. MCP — in-memory transport, no process or socket:
const tools = await t.mcp.listTools();

await t.stop(); // or rely on `await using`
```

Notes:

- Overrides are applied **after** the app constructor — rebinding by key wins.
- The REST server is forced to `port: 0` (ephemeral) and MCP stdio is forced
  off, so tests never collide or grab stdin. Other config passes through
  `options.config[bindingKey]`.
- `t.mcp` exercises the same scope-filtered session building as an
  authenticated HTTP transport (`mcpScopes`), so `@authorize`-gated tool
  visibility is testable in-process.
- `@agentback/mcp` and the MCP SDK are optional peers — apps without an
  MCP server never load them; `t.mcp` throws a clear error instead.
