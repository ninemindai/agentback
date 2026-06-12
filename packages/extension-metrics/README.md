# @agentback/extension-metrics

> Prometheus `/metrics` endpoint and HTTP request-duration histogram for any `RestApplication`.

Wraps [`prom-client`](https://github.com/siimon/prom-client). Two function calls — one to mount the endpoint, one optional one to scope it to a custom registry — and you're done.

```bash
pnpm add @agentback/extension-metrics prom-client
```

## What it provides

- `installMetrics(app, options?)` — async helper; call before `app.start()`. Resolves the `RestServer` from DI and mounts the metrics endpoint.
- `mountMetrics(server, options?)` — lower-level variant that takes a `RestServer` directly.
- `MetricsOptions` — configuration interface (all fields optional).
- `promClient` — re-export of the `prom-client` default export for defining custom metrics without adding a second `prom-client` import in the caller.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {installMetrics, promClient} from '@agentback/extension-metrics';

const app = new RestApplication({rest: {port: 3000}});

await installMetrics(app, {
  path: '/metrics', // default
  collectDefault: true, // Node.js process metrics (cpu, mem, gc, event-loop)
  defaultPrefix: '', // prefix for the default metrics, e.g. 'myapp_'
  httpDurationHistogram: true, // http_request_duration_seconds{method,route,status_code}
});

// Define a custom counter using the same prom-client instance:
const apiCalls = new promClient.Counter({
  name: 'api_calls_total',
  help: 'Total number of API calls',
  labelNames: ['endpoint'],
});

await app.start();
// GET /metrics → Prometheus text format
```

## `MetricsOptions`

| option                  | default    | meaning                                                      |
| ----------------------- | ---------- | ------------------------------------------------------------ |
| `path`                  | `/metrics` | URL path for the scrape endpoint                             |
| `collectDefault`        | `true`     | Register Node.js process metrics via `collectDefaultMetrics` |
| `defaultPrefix`         | `''`       | Prefix applied to default metric names                       |
| `httpDurationHistogram` | `true`     | Add `http_request_duration_seconds` histogram per request    |
| `registry`              | global     | Custom `prom-client` Registry; defaults to `client.register` |

The request-duration histogram labels: `method` (GET/POST/…), `route` (Express route pattern or request path), `status_code`.

## Layering

Depends on: `@agentback/rest`, `prom-client`.

Mounts on the Express app exposed by `RestServer.expressApp` — below the REST router, so the `/metrics` path is not part of the OpenAPI spec. Works alongside `@agentback/extension-health`.
