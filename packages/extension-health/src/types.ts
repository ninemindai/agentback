// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * A single check that contributes to the application's readiness state.
 * Throw (or return `{ok: false}`) to mark the application as not-ready;
 * resolving cleanly counts as a pass.
 */
export interface HealthCheck {
  /** Stable name surfaced in the /ready response body. */
  name: string;
  /** Liveness or readiness. Liveness checks affect /health; default is readiness. */
  type?: 'liveness' | 'readiness';
  /** Optional max time before the check is treated as failing. */
  timeoutMs?: number;
  /** Run the check. Throw or return `{ok:false, info}` to fail. */
  check(): Promise<void | {ok: boolean; info?: unknown}>;
}

export interface HealthCheckResult {
  name: string;
  ok: boolean;
  durationMs: number;
  info?: unknown;
  error?: string;
}

export interface HealthOptions {
  /** URL path for the liveness endpoint. Default `/health`. */
  healthPath?: string;
  /** URL path for the readiness endpoint. Default `/ready`. */
  readyPath?: string;
  /** Default per-check timeout. Default 5000 ms. */
  defaultTimeoutMs?: number;
}

export const DEFAULT_HEALTH_OPTIONS: Required<HealthOptions> = {
  healthPath: '/health',
  readyPath: '/ready',
  defaultTimeoutMs: 5000,
};

export const HEALTH_CHECK_TAG = 'healthCheck';
