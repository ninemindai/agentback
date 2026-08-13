// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request, Response, NextFunction} from 'express';
import type {Installed} from '@agentback/core';
import type {RestApplication, RestServer} from '@agentback/rest';
import client from 'prom-client';

export interface MetricsOptions {
  /** URL path for the metrics endpoint. Default `/metrics`. */
  path?: string;
  /** Collect Node.js process metrics (cpu/mem/gc/eventloop). Default true. */
  collectDefault?: boolean;
  /** Prefix for the default metrics. Default `''` (Prometheus convention). */
  defaultPrefix?: string;
  /** Add an HTTP request-duration histogram. Default true. */
  httpDurationHistogram?: boolean;
  /** Custom registry, otherwise use the global one. */
  registry?: client.Registry;
}

const DEFAULTS: Required<Omit<MetricsOptions, 'registry'>> = {
  path: '/metrics',
  collectDefault: true,
  defaultPrefix: '',
  httpDurationHistogram: true,
};

/**
 * Mount /metrics on the application's REST server. Call BEFORE `app.start()`.
 *
 * Exposes Prometheus-format text at `options.path` (default `/metrics`).
 * By default also registers Node.js process metrics and a request-duration
 * histogram labeled by method/route/status_code.
 */
export async function installMetrics(
  app: RestApplication,
  options: MetricsOptions = {},
): Promise<Installed> {
  const server: RestServer = await app.restServer;
  return mountMetrics(server, options);
}

export function mountMetrics(
  server: RestServer,
  options: MetricsOptions = {},
): Installed {
  const opts = {...DEFAULTS, ...options};
  const registry = options.registry ?? client.register;

  if (opts.collectDefault) {
    client.collectDefaultMetrics({
      register: registry,
      prefix: opts.defaultPrefix,
    });
  }

  // Express cannot unmount a layer; the middleware and route share one gate
  // (revertible-installs.md, option 1). Registry side effects: the duration
  // histogram is removed on uninstall only when this mount created it;
  // collectDefaultMetrics registers process-global collectors with no
  // removal handle — a documented carve-out.
  let live = true;

  let durationHistogram: client.Histogram<string> | undefined;
  let createdHistogram = false;
  if (opts.httpDurationHistogram) {
    // Allow re-registration in dev/HMR by re-using the existing metric if any.
    const existing = registry.getSingleMetric('http_request_duration_seconds');
    createdHistogram = !existing;
    durationHistogram =
      (existing as client.Histogram<string>) ??
      new client.Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration in seconds, labeled by method/route/status',
        labelNames: ['method', 'route', 'status_code'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [registry],
      });
  }

  const expressApp = server.expressApp;

  if (durationHistogram) {
    expressApp.use((req: Request, res: Response, next: NextFunction) => {
      if (!live) return next();
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const end = process.hrtime.bigint();
        const seconds = Number(end - start) / 1e9;
        const route =
          (req as Request & {route?: {path: string}}).route?.path ?? req.path;
        durationHistogram!
          .labels(req.method, route, String(res.statusCode))
          .observe(seconds);
      });
      next();
    });
  }

  expressApp.get(
    opts.path,
    (_req, _res, next) =>
      live ? next() : (next as (e?: unknown) => void)('route'),
    async (_req, res) => {
      res.set('Content-Type', registry.contentType);
      res.send(await registry.metrics());
    },
  );
  return {
    uninstall: async () => {
      if (!live) return;
      live = false;
      if (createdHistogram) {
        registry.removeSingleMetric('http_request_duration_seconds');
      }
    },
  };
}

export {client as promClient};
