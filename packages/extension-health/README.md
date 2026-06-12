# @agentback/extension-health

> Kubernetes-shaped liveness and readiness HTTP probes for any `RestApplication`.

Mounts `/health` (liveness) and `/ready` (readiness) on the application's Express server. Checks are plain DI bindings tagged `healthCheck` — no subclassing required.

```bash
pnpm add @agentback/extension-health
```

## What it provides

- `installHealth(app, options?)` — async helper; call before `app.start()`. Resolves the `RestServer` from DI and mounts both endpoints.
- `mountHealth(server, options?)` — lower-level variant that takes a `RestServer` directly.
- `registerHealthCheck(app, key, check)` — convenience wrapper that binds a `HealthCheck` object and tags it `healthCheck`.
- `HealthCheck` interface — `{name, type?, timeoutMs?, check()}`.
- `HealthCheckResult` interface — `{name, ok, durationMs, info?, error?}`.
- `HealthOptions` interface — `{healthPath?, readyPath?, defaultTimeoutMs?}`.
- `HEALTH_CHECK_TAG` — the string tag used to discover checks (`'healthCheck'`).

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {
  installHealth,
  registerHealthCheck,
} from '@agentback/extension-health';
import type {HealthCheck} from '@agentback/extension-health';

const app = new RestApplication({rest: {port: 3000}});

// Register a readiness check (default type).
const dbCheck: HealthCheck = {
  name: 'database',
  async check() {
    await db.ping(); // throws → check fails
  },
};
registerHealthCheck(app, 'health.checks.database', dbCheck);

// Or bind a class that implements HealthCheck:
class CacheCheck implements HealthCheck {
  name = 'cache';
  type = 'liveness' as const;
  async check() {
    const ok = await cache.ping();
    return {ok, info: {latencyMs: ok ? cache.lastLatency : undefined}};
  }
}
app.bind('health.checks.cache').toClass(CacheCheck).tag('healthCheck');

await installHealth(app, {
  healthPath: '/health',
  readyPath: '/ready',
  defaultTimeoutMs: 3000,
});
await app.start();

// GET /health → 200 {status:'UP', checks:[…]}   (or 503 DOWN if liveness check fails)
// GET /ready  → 200 {status:'READY', checks:[…]} (or 503 NOT_READY if any readiness check fails)
```

## Endpoint contract

| Endpoint  | Type      | 200 body                       | 503 body                           |
| --------- | --------- | ------------------------------ | ---------------------------------- |
| `/health` | liveness  | `{status:'UP', checks:[]}`     | `{status:'DOWN', checks:[…]}`      |
| `/ready`  | readiness | `{status:'READY', checks:[…]}` | `{status:'NOT_READY', checks:[…]}` |

Each `checks` entry: `{name, ok, durationMs, info?, error?}`. Checks run in parallel; a per-check `timeoutMs` (or `defaultTimeoutMs`) races against each one.

## Layering

Depends on: `@agentback/context`, `@agentback/core`, `@agentback/rest`.

Mounts on the Express app exposed by `RestServer.expressApp` — no REST routing, no OpenAPI spec entry. Works alongside `@agentback/extension-metrics`.
