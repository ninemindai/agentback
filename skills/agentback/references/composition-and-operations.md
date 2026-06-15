# Composition and Operations

## Table of Contents

- [Components](#components)
- [Middleware](#middleware)
- [CORS](#cors)
- [Subclassing the Dispatcher](#subclassing-the-dispatcher)
- [Operational Extensions](#operational-extensions)
- [Lifecycle Observers](#lifecycle-observers)
- [Adding a New Workspace Package](#adding-a-new-workspace-package)
- [Key Rules](#key-rules)

## Components

A `Component` is the unit of composition in AgentBack. It declares a
bundle of artifacts — services, bindings, controllers, servers, and nested
sub-components — that `app.component(X)` installs in one call.

```ts
import {Binding, Component} from '@agentback/core';

class MyComponent implements Component {
  components = [AuthComponent]; // sub-components installed recursively
  services = [MyService, MyProvider]; // bound via createBindingFromClass
  bindings = [Binding.bind('my.config').to({timeout: 5000})];
}

app.component(MyComponent);
```

`mountComponent` iterates `classes`, `providers`, `bindings`, `controllers`,
`services`, and `components` in that order. `@mcpServer()` and `@api()` tagging
flows from `@bind` metadata read by `createServiceBinding` — never call
`.tag()` manually for service/controller registrations.

## Middleware

`RestApplication` (and any `Application` subclass mixed with `MiddlewareMixin`)
exposes two registration methods. Middleware runs **before route handlers** in
DI-sorted order.

```ts
import {RestApplication} from '@agentback/rest';
import helmet from 'helmet';

const app = new RestApplication({rest: {port: 3000}});

// Raw LoopBack Middleware — MiddlewareContext carries request/response
app.middleware(async (middlewareCtx, next) => {
  console.log(`${middlewareCtx.request.method} ${middlewareCtx.request.url}`);
  return next();
});

// Express factory-style — most third-party middleware fits here
app.expressMiddleware(helmet);
app.expressMiddleware(morgan, 'combined');
```

`MiddlewareContext.request` and `.response` are standard Express objects, so
existing Express middleware drops in without adaptation. Middleware that calls
`res.send()` without calling `next()` **short-circuits the chain** — that is
how CORS preflights, rate-limit `429` responses, and `/health` probes bypass
route handlers. Sort order is controlled by the `group` option in `asMiddleware`;
the defaults are correct for most cases.

## CORS

CORS is built into `RestServer`. Configure it via `RestServerConfig`:

```ts
import {RestApplication} from '@agentback/rest';
import type {CorsOptions} from 'cors';

// Permissive defaults (useful for local dev)
const app = new RestApplication({rest: {port: 3000, cors: true}});

// Full CorsOptions (from the `cors` npm package)
const corsOptions: CorsOptions = {
  origin: ['https://app.example.com', 'https://staging.example.com'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
const app2 = new RestApplication({rest: {port: 3000, cors: corsOptions}});
```

When `cors` is set, `RestServer` mounts the `cors` package globally in its
constructor — before `express.json()` and before any route handlers. Omitting
the key disables CORS entirely.

## Subclassing the Dispatcher

`RestServer.makeHandler`, `dispatch`, `sendResult`, and `sendError` are all
`protected`. Subclass to customize the per-request pipeline without touching
routing or DI wiring, then register via `app.server(MySubclass)`.

```ts
import {RestServer} from '@agentback/rest';
import type {Request, Response} from 'express';

class EnvelopedRestServer extends RestServer {
  // Wrap every success response in a standard envelope
  protected override sendResult(
    res: Response,
    result: unknown,
    status: number,
  ) {
    if (status === 204) {
      res.status(204).end();
      return;
    }
    res.status(status).json({ok: true, data: result});
  }

  // Uniform error shape
  protected override sendError(req: Request, res: Response, err: unknown) {
    const status = (err as {status?: number}).status ?? 500;
    res.status(status).json({
      ok: false,
      error: {
        statusCode: status,
        message: (err as Error).message,
        requestId: req.headers['x-request-id'],
      },
    });
  }
}

const app = new RestApplication();
app.server(EnvelopedRestServer);
```

Override `dispatch` to add audit logging, distributed tracing, or transaction
boundaries around the auth → authz → validation → handler → response-validation
pipeline. Override `makeHandler` only to replace the entire per-route Express
handler factory.

## Operational Extensions

All three operational extensions share the same two-call pattern:

- `install*(app, options?)` — async; resolves the `RestServer` from DI.
  Call **before** `app.start()`.
- `mount*(server, options?)` — synchronous; takes a `RestServer` directly.

Both ultimately call `server.expressApp.use(...)` — the paths (`/health`,
`/ready`, `/metrics`) mount on the same Express app but are **not** registered
in the OpenAPI spec.

### Health (Kubernetes probes)

```ts
import {installHealth, registerHealthCheck} from '@agentback/extension-health';

registerHealthCheck(app, 'health.checks.db', {
  name: 'database',
  async check() {
    await db.ping();
  }, // throws → check fails
});
registerHealthCheck(app, 'health.checks.cache', {
  name: 'cache',
  type: 'liveness',
  timeoutMs: 1000,
  async check() {
    await cache.ping();
  },
});

// GET /health → 200 {status:'UP'} / 503 {status:'DOWN'}
// GET /ready  → 200 {status:'READY'} / 503 {status:'NOT_READY'}
await installHealth(app, {
  healthPath: '/health',
  readyPath: '/ready',
  defaultTimeoutMs: 3000,
});
await app.start();
```

Checks are DI bindings tagged `healthCheck` (`HEALTH_CHECK_TAG`).
`registerHealthCheck` is a convenience wrapper; alternatively bind a class:
`app.bind(key).toClass(MyCheck).tag('healthCheck')`.

### Metrics (Prometheus)

```ts
import {installMetrics, promClient} from '@agentback/extension-metrics';

await installMetrics(app, {
  path: '/metrics', // default
  collectDefault: true, // Node.js process metrics (cpu/mem/gc/event-loop)
  httpDurationHistogram: true, // http_request_duration_seconds{method,route,status_code}
});

// Define custom metrics using the same prom-client instance
const apiCalls = new promClient.Counter({
  name: 'api_calls_total',
  help: 'Total API calls',
  labelNames: ['endpoint'],
});

await app.start(); // GET /metrics → Prometheus text format
```

### Rate Limiting

`@agentback/extension-rate-limit` follows the same `install*` pattern and,
mounted globally, covers every route (including `/mcp`):

```ts
import {installRateLimit} from '@agentback/extension-rate-limit';

// 100 req / 60 s per client IP, in-memory
await installRateLimit(app, {points: 100, durationSecs: 60});
await app.start();
```

For the full options (Redis store, `path` scoping, `keyGenerator`, `skip`, the
`429` + `RateLimit-*` header behavior) and per-tool limiting for MCP-over-HTTP,
see [`auth-and-rate-limiting.md`](auth-and-rate-limiting.md).

## Lifecycle Observers

`@lifeCycleObserver(group, ...specs)` marks a class as a lifecycle observer.
`app.start()` calls `init()` then `start()` on all observers in
alphabetically-sorted group order; `app.stop()` calls `stop()` in reverse.
Prefix group names with digits for deterministic ordering.

```ts
import {lifeCycleObserver, LifeCycleObserver} from '@agentback/core';

@lifeCycleObserver('10-database')
class DatabaseObserver implements LifeCycleObserver {
  async start() {
    await db.connect();
  }
  async stop() {
    await db.disconnect();
  }
}

@lifeCycleObserver('20-cache')
class CacheObserver implements LifeCycleObserver {
  async start() {
    await cache.connect();
  }
  async stop() {
    await cache.disconnect();
  }
}

app.lifeCycleObserver(DatabaseObserver);
app.lifeCycleObserver(CacheObserver);
```

`init()` is called at most once per application instance. Observers that only
need `start`/`stop` can omit `init`.

## Adding a New Workspace Package

1. **Scaffold** `packages/<name>/src/index.ts`, plus `package.json` and
   `tsconfig.json`:

   ```json
   // package.json — minimum required shape
   {
     "name": "@agentback/<name>",
     "version": "0.0.0",
     "type": "module",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "exports": {
       ".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}
     },
     "files": ["dist", "src"],
     "scripts": {"build": "tsc -b", "clean": "rm -rf dist *.tsbuildinfo"},
     "dependencies": {
       "@agentback/core": "workspace:*",
       "tslib": "^2.8.1"
     },
     "devDependencies": {"vitest": "~4.1.8", "zod": "^4.4.3"},
     "engines": {"node": ">=22.13"}
   }
   ```

   ```json
   // tsconfig.json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": {
       "rootDir": "src",
       "outDir": "dist",
       "tsBuildInfoFile": "./tsconfig.tsbuildinfo"
     },
     "include": ["src/**/*"],
     "exclude": ["dist", "node_modules"],
     "references": [{"path": "../core"}]
   }
   ```

2. **Add to root `tsconfig.json` references** in dependency order:

   ```json
   {"path": "packages/<name>"}
   ```

3. **Wire workspace symlinks**: `pnpm install`

4. **Tests** live under `src/__tests__/**` (`*.unit.ts`, `*.integration.ts`,
   `*.acceptance.ts`). Vitest picks them up from `dist/__tests__/**/*.js` —
   always `pnpm build` before `pnpm test`.

## Testing an app

`@agentback/testing`'s `createTestApp` boots an app on an ephemeral port and
hands back a typed REST `client`, raw `supertest`, and an in-memory `mcp` client
(SDK `Client`) — `await using` disposes it:

```ts
import {createTestApp} from '@agentback/testing';

await using t = await createTestApp(() => new Application({stdio: false}));
const {tools} = await t.mcp.listTools(); // in-memory MCP — no transport
const res = await t.client.get('/greet/hello/world'); // typed REST client
await t.supertest.post('/mcp').set('x-api-key', 'k'); // status/header asserts
```

For HTTP-gate behavior the in-memory `mcp` client can't see — auth `401`s, rate
`429`s — drive the real Express stack with raw `fetch` against `t.url`/the server
URL.

**Make entries testable.** An entry file that builds _and starts_ the server at
module top level can't be imported by a test. Export a factory that builds (not
starts) the app, and guard the run with `isMain`:

```ts
export async function buildApp(opts = {}) {
  /* … new RestApplication(); installMcpHttp(app, …); return app; */
}
if (isMain(import.meta)) {
  const app = await buildApp({port: Number(process.env.PORT ?? 3000)});
  await app.start();
}
```

Now `npm start` runs the server while a test imports `buildApp`, starts it on
port `0`, and asserts against it.

### Serverless deployment (`listen: false`)

The same `buildApp` factory also deploys to a serverless platform (Vercel,
AWS Lambda). Set `listen: false` on the RestServer config: `app.start()` then
mounts every route — middleware, controllers, framework routes (`/openapi.json`,
explorers, …) — but **skips `app.listen()`**. The platform owns the HTTP
listener; you hand it the fully-mounted Express app via `RestServer.expressApp`.

```ts
export async function buildApp({listen = true} = {}) {
  const app = new RestApplication({rest: {listen}});
  // … register controllers / services / installConsole / installMcpHttp …
  await app.start();            // listen:false → routes mounted, no port bound
  return app;
}

// api/index.ts (Vercel) — one function for the whole app, built once (memoized)
let appP;
export default async function handler(req, res) {
  appP ??= buildApp({listen: false}).then(async a => (await a.restServer).expressApp);
  (await appP)(req, res);
}
```

`new RestApplication({rest: {listen: false}})` is the toggle; default `true`
binds a port as a normal long-running server. Two deploy notes:

- **On-disk static assets** served by `installConsole` / `rest-explorer` (the
  console client bundle, `swagger-ui-dist`) are read at runtime, not imported,
  so the platform's file tracer misses them — list them in Vercel's
  `includeFiles` (or the equivalent) for the function.
- **Workspace symlinks** (pnpm `workspace:*`) break serverless function
  packaging; deploy from a project that installs `@agentback/*` as normal
  (copied) dependencies.

## Key Rules

- **ESM `.js` extensions on all relative imports** — `import {foo} from './bar.js'`
  even though the source file is `bar.ts`. TypeScript + `"module": "nodenext"`
  requires this.
- **Tests run from `dist/`**, never from `src/`. Edit `.ts`, build, then test.
- **Three-line MIT header** on every new source file:
  ```ts
  // Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
  // Node module: @agentback/<pkg>
  // This file is licensed under the MIT License.
  ```
- **`composite: true`** is set in `tsconfig.base.json` — every package is a
  TypeScript project reference. The root `tsconfig.json` drives the full build
  order; per-package `tsconfig.json` declares only its direct upstream deps as
  `references`.
- **`pnpm -F @agentback/<name> build`** builds a single package without
  rebuilding the entire workspace (useful during development).
