# @agentback/rest

> Minimal REST server: schema-driven routing, Zod request/response validation, auth integration, and `/openapi.json` — all in one fixed pipeline.

`RestServer` is a slim Express wrapper that mounts controllers registered with `@get`/`@post`/… decorators,
validates every request and response against the Zod schemas declared on those decorators, and serves the
assembled OpenAPI 3.1.1 document at `/openapi.json`. Authentication and authorization hooks run in the same
pipeline via `@agentback/authentication` and `@agentback/authorization` metadata.

There are no sequences or action chains — `RestServer.dispatch` is a single fixed pipeline. Per-route
customization lives on decorator options; cross-cutting concerns go in Express middleware registered via
`app.middleware()`; deeper changes come from subclassing `RestServer` and overriding `dispatch`,
`makeHandler`, `sendResult`, or `sendError`.

## What it provides

- `RestServer` — Express-backed server; mounts controllers, validates I/O, assembles and serves the spec
- `RestApplication` — `Application` subclass with `MiddlewareMixin`; pre-binds `RestServer`; exposes `app.restController()`, `app.restServer`, `app.middleware()`, `app.expressMiddleware()`
- `RestServerConfig` — `{port?, host?, basePath?, openApiSpec?: {path?, overrides?}, cors?}`
- `RestBindings` — DI keys: `RestBindings.SERVER`, `RestBindings.CONFIG`
- Controllers are discovered by the core `controller` tag (`CoreTags.CONTROLLER` from `@agentback/core`); `app.restController()` is a thin, REST-flavored alias for `app.controller()` and adds no separate tag
- Per-request cancellation: `CoreBindings.ABORT_SIGNAL` is bound into every request context on both the Express and Web pipelines, aborting when the client hangs up. Inject it optionally and hand it to whatever spends time or money — see [docs/concepts/cancellation.md](../../docs/concepts/cancellation.md)
- Resumable SSE: `@get(..., {streamOf, resumable})` keeps the producer alive across a dropped connection and replays the gap to a reconnecting `EventSource` via `Last-Event-ID` — the handler is not re-invoked, so a browser refresh no longer costs an in-flight agent turn. Bounded by `windowMs` + `maxEvents` and a server-wide `rest.resumable.maxLiveStreams` cap (default 1000; a new stream past it gets 503 + `Retry-After`). A `Last-Event-ID` that cannot be honoured — unknown, expired, past the ring, or from another route or principal — gets HTTP 409, so `EventSource` stops and the handler never re-runs; on an anonymous route the stream id is a bearer capability. Normal completion does not abort the handler's signal. SSE-only and single-process. See [docs/guides/streaming.md](../../docs/guides/streaming.md#7-resumable-streams-sse)
- Error helpers: `invalidParameter(field, message)`, `invalidRequestBody(details)`, `zodIssuesToDetails(issues)` — produce HTTP 400/422 error shapes from Zod validation failures

## Request pipeline

> Standalone diagrams of the middleware chain that fronts this pipeline: the
> structure (group-sorted `cors → parseBody → middleware`, mounted as the first
> Express handler) —
> [`middleware-chain.html`](../../docs/architecture/diagrams/middleware-chain.html);
> and a live request trace (POST `/mcp` ①→⑦, OPTIONS-preflight short-circuit) —
> [`mcp-request-lifecycle.html`](../../docs/architecture/diagrams/mcp-request-lifecycle.html).

```mermaid
flowchart LR
    A[HTTP request] --> B[group-sorted middleware chain\ncors → parseBody → middleware]
    B --> C[Route match]
    C -->|no match| E1[404]
    C --> D[Zod validate\nbody / path / query / headers]
    D -->|invalid| E2[400 / 422]
    D --> F[Authentication]
    F -->|unauthenticated| E3[401]
    F --> G[Authorization]
    G -->|denied| E4[403]
    G --> H[Controller method\nslot-0 = input bundle]
    H --> I[Zod validate response\nlog on mismatch]
    I --> J[send JSON]
```

## Usage

```ts
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';

const GreetPath = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});

@api({basePath: '/greet'})
class GreetController {
  @get('/hello/{name}', {path: GreetPath, response: Greeting})
  async hello(input: {path: z.infer<typeof GreetPath>}) {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {body: Greeting, response: Greeting, status: 200})
  async echo(input: {body: z.infer<typeof Greeting>}) {
    return input.body;
  }
}

const app = new RestApplication({
  rest: {port: 3000, cors: true},
});
app.restController(GreetController);
await app.start();
// GET  /greet/hello/Alice  → {"greeting":"Hello, Alice!"}
// GET  /openapi.json       → OpenAPI 3.1.1 document
```

**Adding middleware** (runs before every route handler):

```ts
import helmet from 'helmet';

app.expressMiddleware(helmet);
// or a raw function:
app.middleware((ctx, next) => {
  /* ... */ return next();
});
```

**Subclassing for custom error shapes:**

```ts
import {RestServer} from '@agentback/rest';

class MyServer extends RestServer {
  protected override sendError(res, err) {
    res.status(err.statusCode ?? 500).json({ok: false, error: err.message});
  }
}
// app.server(MyServer);
```

**Config reference:**

| Option                  | Default           | Notes                                 |
| ----------------------- | ----------------- | ------------------------------------- |
| `port`                  | `3000`            | TCP port                              |
| `host`                  | `'127.0.0.1'`     | Bind address                          |
| `basePath`              | `''`              | Prefix for all routes                 |
| `openApiSpec.path`      | `'/openapi.json'` | Spec endpoint                         |
| `openApiSpec.overrides` | `{}`              | Merged into assembled spec            |
| `cors`                  | `undefined`       | `true` for defaults, or `CorsOptions` |

## Layering

Depends on: `@agentback/context`, `@agentback/core`, `@agentback/express`,
`@agentback/http-server`, `@agentback/metadata`, `@agentback/openapi`,
`@agentback/authentication`, `@agentback/authorization`, `@agentback/security`,
`cors`, `express ^4`, `zod ^4`. Sits at the top of the server stack; `@agentback/rest-explorer`
and `@agentback/console` mount additional UI routes on top of it.
