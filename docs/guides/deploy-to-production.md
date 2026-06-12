# Deploy to production

This guide takes an AgentBack service from `pnpm start` on a laptop to a
container behind a load balancer: configuration, probes, metrics, tracing,
graceful shutdown, and the multi-instance gotchas.

## Build and run

A service is plain ESM Node — `pnpm build` emits `dist/`, and production runs
`node dist/main.js`. Nothing in the framework needs a bundler, a custom
runtime, or a build plugin.

A multi-stage Dockerfile (pnpm workspace layout):

```dockerfile
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/my-service ./apps/my-service
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter my-service deploy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

For a standalone (non-workspace) service, replace the `pnpm deploy` step
with `pnpm prune --prod` in place.

## Configuration

Bind the listen address from the environment; everything else through
`@agentback/config` so it is **validated at startup** instead of
failing at first use:

```ts
import {loadConfigFile} from '@agentback/config';

const AppConfig = z.object({
  database: z.object({url: z.string().url()}),
  auth: z.object({jwksUri: z.string().url()}),
});

const config = loadConfigFile('config.jsonc', AppConfig); // throws on invalid

const app = new RestApplication();
app.configure('servers.RestServer').to({
  port: Number(process.env.PORT ?? 3000),
  host: '0.0.0.0', // containers: bind all interfaces, not 127.0.0.1
});
```

The loader reads `config/config.jsonc`, deep-merges
`config/config.<NODE_ENV>.jsonc` on top, and resolves `${VAR}` /
`${VAR:-default}` interpolations from the environment — so secrets stay in
env vars while structure stays in files. A missing variable without a
default throws at startup.

Behind a path-prefixing proxy, set `basePath` in the same config object —
`/openapi.json`, `/llms.txt`, and the explorer all mount under it.

## Probes (Kubernetes-shaped)

```ts
import {
  installHealth,
  registerHealthCheck,
} from '@agentback/extension-health';

await installHealth(app); // GET /health (liveness), GET /ready (readiness)
registerHealthCheck(app, {
  name: 'db',
  type: 'readiness',
  check: async () => void (await db.execute(sql`select 1`)),
});
```

`/health` runs liveness checks and answers `200 {status: 'UP'}` / `503`;
`/ready` runs readiness checks. Wire them directly:

```yaml
livenessProbe:
  httpGet: {path: /health, port: 3000}
readinessProbe:
  httpGet: {path: /ready, port: 3000}
```

## Metrics and tracing

```ts
import {installMetrics} from '@agentback/extension-metrics';
import {installOtel} from '@agentback/extension-otel';

await installMetrics(app); // Prometheus text at /metrics:
// process metrics + request-duration histogram
await installOtel(app); // spans for every REST dispatch and MCP tool call
```

`extension-otel` depends only on `@opentelemetry/api` — **you bring the
SDK** and exporter in your entrypoint, before the app starts:

```ts
import {NodeSDK} from '@opentelemetry/sdk-node';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  serviceName: 'my-service',
  traceExporter: new OTLPTraceExporter(), // honors OTEL_EXPORTER_OTLP_ENDPOINT
});
sdk.start();
```

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector (Jaeger, Tempo,
Datadog agent — anything OTLP). When metering is installed, `installOtel`
also stamps the active trace id onto every usage event, so billing records
and traces share a join key.

## Graceful shutdown

The HTTP server already closes gracefully (in-flight requests drain, new
connections are refused). Hook the signals:

```ts
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    app.stop().then(
      () => process.exit(0),
      err => {
        console.error(err);
        process.exit(1);
      },
    );
  });
}
```

`app.stop()` stops every bound server (REST, MCP transports) and runs
lifecycle observers' `stop()` — close DB pools and queue connections there.

## Multi-instance checklist

Several conveniences default to **per-process in-memory state**. Fine on one
instance; on two or more, bind shared implementations:

| Feature                | Default           | Multi-instance binding                                                    |
| ---------------------- | ----------------- | ------------------------------------------------------------------------- |
| Rate limiting          | in-memory buckets | `installRateLimit(app, {redis: …})` (Redis-backed)                        |
| `confirm:` tokens      | in-memory store   | bind `RestBindings.CONFIRMATION_STORE` / `MCPBindings.CONFIRMATION_STORE` |
| `idempotency:` replay  | in-memory store   | bind `RestBindings.IDEMPOTENCY_STORE`                                     |
| Metering sink          | in-memory log     | bind `MeteringBindings.SINK` (Redis/JSONL/composite ship in-box)          |
| MCP resumable sessions | none              | pass a shared `EventStore` to `installMcpHttp`                            |
| Job queue / event bus  | in-memory adapter | `@agentback/messaging-bullmq` (BullMQ + Redis Streams)               |

Also remember that MCP-over-HTTP sessions are sticky to an instance unless
you enable session resumability — terminate MCP at one instance or use a
session-affinity LB policy.

## Exposure checklist

- `cors:` — off by default; enable deliberately (`true` or `CorsOptions`).
- `/mcp` — if exposed, read
  [Secure MCP over HTTP](secure-mcp-over-http.md) first: auth, DNS-rebinding
  allowlists, per-tool rate limits.
- `/openapi.json`, `/llms.txt`, `/explorer`, `/mcp-inspector` — public by
  default. The spec and AX artifacts are usually fine to leave public (they
  are the product); gate or disable the explorer/inspector UIs in production
  if your API is not.
- Set `DEBUG=` (empty) in production; enable namespaces selectively when
  debugging (`DEBUG=agentback:rest:*`).
