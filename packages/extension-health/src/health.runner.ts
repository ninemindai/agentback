// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {
  HEALTH_CHECK_TAG,
  type HealthCheck,
  type HealthCheckResult,
} from './types.js';

async function runOne(
  check: HealthCheck,
  defaultTimeoutMs: number,
): Promise<HealthCheckResult> {
  const start = Date.now();
  const timeoutMs = check.timeoutMs ?? defaultTimeoutMs;
  try {
    const result = await Promise.race([
      check.check(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`check timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
    if (result && (result as {ok: boolean}).ok === false) {
      return {
        name: check.name,
        ok: false,
        durationMs: Date.now() - start,
        info: (result as {info?: unknown}).info,
      };
    }
    return {
      name: check.name,
      ok: true,
      durationMs: Date.now() - start,
      info: (result as {info?: unknown} | undefined)?.info,
    };
  } catch (err) {
    return {
      name: check.name,
      ok: false,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    };
  }
}

/**
 * Collect every check bound under the `healthCheck` tag and run them in
 * parallel. Filter by `type` to scope to liveness vs readiness.
 */
export async function runChecks(
  ctx: Context,
  type: 'liveness' | 'readiness',
  defaultTimeoutMs: number,
): Promise<HealthCheckResult[]> {
  const bindings = ctx.findByTag(HEALTH_CHECK_TAG);
  const checks: HealthCheck[] = [];
  for (const b of bindings) {
    const c = await ctx.get<HealthCheck>(b.key);
    if ((c.type ?? 'readiness') === type) checks.push(c);
  }
  return Promise.all(checks.map(c => runOne(c, defaultTimeoutMs)));
}
