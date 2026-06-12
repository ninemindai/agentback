# @agentback/extension-rate-limit

> Rate-limiting middleware backed by `rate-limiter-flexible` — in-memory or
> Redis-backed, with `429` + `RateLimit-*` headers.

Mounts an Express middleware on the REST server that limits requests per key
(client IP by default) over a sliding window. Memory store by default; pass an
ioredis-compatible client to share limits across instances. Follows the same
`install*`/`mount*` pattern as `extension-health` and `extension-metrics`.

```bash
pnpm add @agentback/extension-rate-limit
```

## What it provides

| Export                                | Purpose                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `installRateLimit(app, options?)`     | Resolve the REST server and mount rate limiting. Call before `app.start()`.                                              |
| `mountRateLimit(server, options?)`    | Mount on a `RestServer`'s Express app directly (supports `path` to scope it).                                            |
| `createRateLimitMiddleware(options?)` | The raw Express `RequestHandler` for manual mounting.                                                                    |
| `RateLimitOptions`                    | `points`, `durationSecs`, `blockSecs`, `keyPrefix`, `keyGenerator`, `skip`, `store`, `headers`, `statusCode`, `message`. |
| `RateLimiterRes`                      | Re-export from `rate-limiter-flexible`.                                                                                  |

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {installRateLimit} from '@agentback/extension-rate-limit';

const app = new RestApplication({});
app.restController(MyController);

// 100 requests / 60s per client IP (in-memory).
await installRateLimit(app, {points: 100, durationSecs: 60});

// Redis-backed + a custom key, scoped to /api:
await installRateLimit(app, {
  path: '/api',
  points: 1000,
  durationSecs: 60,
  store: redisClient, // ioredis-compatible
  keyGenerator: req => (req.headers['x-api-key'] as string) ?? req.ip ?? 'anon',
  skip: req => req.path === '/health',
});

await app.start();
```

On the limit being exceeded the middleware responds `429` (configurable) with
`{error: {statusCode, message}}` and sets `Retry-After`. Every response carries
`RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset`. Store failures
(e.g. Redis down) **fail open** — requests pass rather than 500.

## Layering

Depends on: `@agentback/rest`, `rate-limiter-flexible`, `express`. Mounts as
ordinary Express middleware via `server.expressApp.use(...)`, so it runs ahead of
route handlers. For finer control, compose `createRateLimitMiddleware` yourself.
