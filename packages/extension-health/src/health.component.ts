// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RestApplication, RestServer} from '@agentback/rest';
import {runChecks} from './health.runner.js';
import {
  DEFAULT_HEALTH_OPTIONS,
  HEALTH_CHECK_TAG,
  type HealthCheck,
  type HealthOptions,
} from './types.js';

/**
 * Mount /health (liveness) and /ready (readiness) endpoints on the given
 * RestApplication. Call BEFORE `app.start()`.
 *
 * - /health: 200 if the process is up. Optional liveness checks contribute
 *   failure → 503.
 * - /ready: runs every binding tagged `healthCheck` of type readiness;
 *   200 with details when all pass, 503 with details otherwise.
 *
 * Register a check:
 *   app.bind('health.checks.db').to(myCheck).tag('healthCheck');
 *   // myCheck: HealthCheck { name, type?, check() }
 *
 * Or as a service class:
 *   class DbCheck implements HealthCheck { name = 'db'; async check() {...} }
 *   app.bind('health.checks.db').toClass(DbCheck).tag('healthCheck');
 */
export async function installHealth(
  app: RestApplication,
  options: HealthOptions = {},
): Promise<void> {
  const opts = {...DEFAULT_HEALTH_OPTIONS, ...options};
  const server: RestServer = await app.restServer;
  mountHealth(server, opts);
}

export function mountHealth(
  server: RestServer,
  options: HealthOptions = {},
): void {
  const opts = {...DEFAULT_HEALTH_OPTIONS, ...options};
  const expressApp = server.expressApp;
  const ctx = server.appContext;

  expressApp.get(opts.healthPath, async (_req, res) => {
    const results = await runChecks(ctx, 'liveness', opts.defaultTimeoutMs);
    const ok = results.every(r => r.ok);
    res
      .status(ok ? 200 : 503)
      .json({status: ok ? 'UP' : 'DOWN', checks: results});
  });

  expressApp.get(opts.readyPath, async (_req, res) => {
    const results = await runChecks(ctx, 'readiness', opts.defaultTimeoutMs);
    const ok = results.every(r => r.ok);
    res.status(ok ? 200 : 503).json({
      status: ok ? 'READY' : 'NOT_READY',
      checks: results,
    });
  });
}

/**
 * Convenience: helper to bind a `HealthCheck` plain object on the context
 * without the user having to remember the tag name.
 */
export function registerHealthCheck(
  app: RestApplication,
  key: string,
  check: HealthCheck,
): void {
  app.bind(key).to(check).tag(HEALTH_CHECK_TAG);
}
