// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {Binding} from '@agentback/context';
import {CoreTags} from './keys.js';

const log = loggers('agentback:core:refreshable-surface');

/**
 * A server whose externally-served surface is DERIVED from context bindings,
 * and therefore goes stale when bindings change after it was built.
 *
 * Retraction is already live on both hosts — an unbound controller's routes
 * 404, and a retracted `@tool` leaves `tools/list` — because each is re-checked
 * per request. Addition is not: routes are collected once in
 * `RestServer.start()` and a long-lived MCP server bakes its tool map when it
 * is built. A capability bound into a RUNNING app is therefore invisible until
 * the next start, which is the asymmetry this interface closes.
 *
 * Implementations must be idempotent and cheap when nothing changed — a caller
 * that binds ten controllers may refresh once per bind.
 */
export interface RefreshableSurface {
  /** Re-derive the served surface from the current bindings. */
  refreshSurface(): void | Promise<void>;
}

/**
 * The subset of `Application` this needs. Kept structural, like
 * `UnbindableContext` in `installed.ts`, so the helper does not drag the
 * `Application` class into every consumer's type graph.
 */
interface ServerHostContext {
  state: string;
  findByTag(tag: string): Readonly<Binding<unknown>>[];
  getSync<T>(key: string, options: {optional: true}): T | undefined;
}

function isRefreshable(value: unknown): value is RefreshableSurface {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RefreshableSurface).refreshSurface === 'function'
  );
}

/** One server that could not re-derive its surface. */
export interface SurfaceRefreshFailure {
  /** Binding key of the server that failed. */
  key: string;
  error: unknown;
}

/**
 * Ask every bound server that implements {@link RefreshableSurface} to
 * re-derive its surface. Call after binding a capability into a running app.
 *
 * **Only acts on a `started` app**, and that guard is here rather than at each
 * call site for a reason: `getSync` RESOLVES a binding, it does not merely read
 * a cached one, so calling this earlier would construct every server as a side
 * effect of a refresh — a far larger action than the caller asked for, and
 * pointless besides, since before `start()` the normal collection pass has yet
 * to run. On a started app every server is already resolved, so this is a cache
 * hit.
 *
 * **Failures are RETURNED, not swallowed.** This used to log and continue,
 * which is indistinguishable from success: `loggers()` is debug-namespaced, so
 * `log.error` emits nothing unless `DEBUG` matches, and the caller went on to
 * report a mount that serves nothing. Returning them lets the caller decide —
 * `@agentback/plugin` fails the mount and rolls it back, so a plugin handle
 * always means bound AND started AND served.
 *
 * A failure does not stop the loop: every server still gets its chance, so one
 * bad server cannot leave the others stale on top of everything else.
 */
export async function refreshSurfaces(
  app: ServerHostContext,
): Promise<SurfaceRefreshFailure[]> {
  if (app.state !== 'started') return [];
  const failures: SurfaceRefreshFailure[] = [];
  for (const binding of app.findByTag(CoreTags.SERVER)) {
    let server: unknown;
    try {
      server = app.getSync<unknown>(binding.key, {optional: true});
    } catch (err) {
      // An asynchronously-resolved server throws here rather than returning.
      // It is NOT skipped silently: we cannot reach it synchronously, so we
      // also cannot promise its surface is current.
      failures.push({key: binding.key, error: err});
      continue;
    }
    if (!isRefreshable(server)) continue;
    try {
      await server.refreshSurface();
    } catch (err) {
      log.error('server %s failed to refresh its surface: %O', binding.key, err);
      failures.push({key: binding.key, error: err});
    }
  }
  return failures;
}

/** Render refresh failures as one line for a mount error message. */
export function describeSurfaceFailures(
  failures: readonly SurfaceRefreshFailure[],
): string {
  return failures
    .map(f => `${f.key}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
    .join('; ');
}
