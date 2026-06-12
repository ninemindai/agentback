# @agentback/testlab

> Test utilities for AgentBack — a Vitest-friendly port of `@loopback/testlab`.

Use Vitest's built-in `expect`/`describe`/`it` for assertions. This package fills in the gaps: supertest HTTP clients, sinon spies/stubs/timers, a per-test temp sandbox, `@hapi/shot` request stubs, port helpers, and an OpenAPI 3 spec validator.

```bash
pnpm add -D @agentback/testlab
```

## What it provides

| Export                                           | Description                                                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `createClientForHandler(handler)`                | Wraps a raw `http.IncomingMessage` handler in a supertest agent                                       |
| `createRestAppClient(app)`                       | Supertest agent pointed at a running `RestApplication`'s URL                                          |
| `supertest`                                      | Re-exported supertest for direct use                                                                  |
| `Client`                                         | Type alias for the supertest agent returned by both helpers                                           |
| `givenHttpServerConfig(options?)`                | Returns an HTTPS config with bundled self-signed certs + an ephemeral port                            |
| `sinon`                                          | Full sinon re-export — spies, stubs, mocks, fake timers                                               |
| `inject(options)` / `stubServerRequest(options)` | `@hapi/shot` request/response injection stubs                                                         |
| `TestSandbox`                                    | Per-test temp directory: `mkdir`, `copyFile`, `writeTextFile`, `writeJsonFile`, `reset()`, `delete()` |
| `validateApiSpec(spec)`                          | Validates an OpenAPI 3 document via `oas-validator`; throws on invalid                                |
| `toJSON(value)`                                  | `JSON.parse(JSON.stringify(value))` — normalises for deep-equal comparisons                           |
| `skipIf(condition, describe)`                    | Conditionally skip a test suite                                                                       |
| `skipOnTravis(describe)`                         | Skip on Travis CI                                                                                     |

## Usage

```ts
import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {
  sinon,
  createRestAppClient,
  TestSandbox,
  givenHttpServerConfig,
} from '@agentback/testlab';
import {RestApplication} from '@agentback/rest';

describe('MyController', () => {
  let app: RestApplication;
  const sandbox = new TestSandbox('/tmp/my-tests');

  beforeEach(async () => {
    app = new RestApplication({rest: givenHttpServerConfig()});
    app.controller(MyController);
    await app.start();
  });

  afterEach(async () => {
    await app.stop();
    await sandbox.reset();
  });

  it('returns greeting', async () => {
    const client = createRestAppClient(app);
    await client.get('/hello/Alice').expect(200, {greeting: 'Hello, Alice!'});
  });

  it('stubs an external call', async () => {
    const stub = sinon.stub(externalService, 'fetch').resolves({data: 42});
    // … test …
    sinon.restore();
    expect(stub.calledOnce).toBe(true);
  });
});
```

## Notes

- `givenHttpServerConfig()` bundles its own self-signed cert so HTTPS tests work without any local cert setup.
- `TestSandbox` creates a unique temp subdirectory per instance by default, enabling safe parallel test runs.
- `validateApiSpec` uses `oas-validator` which validates against the OpenAPI 3.0 JSON Schema; feed it the output of `GET /openapi.json`.
- Tests must run against built `dist/`. Run `pnpm build` (or keep `pnpm build:watch` running) before `pnpm test`.

## Layering

Depends on: `supertest`, `sinon`, `@hapi/shot`, `fs-extra`, `oas-validator`. No dependency on `@agentback/rest` or `@agentback/context` — callers bring those in themselves.
