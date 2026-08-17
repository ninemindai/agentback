// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  describeSurfaceFailures,
  refreshSurfaces,
  type Application,
} from '@agentback/core';
import type {PluginLoadError} from './types.js';

/**
 * Re-derive every server's served surface, and UNDO the mount if any of them
 * could not.
 *
 * Called once per entry point rather than once per mount, deliberately on both
 * counts:
 *
 * - **Once per entry point**, because a refresh is a global reconcile, not
 *   per-mount state. Inside `mountResolved` it re-derived the whole route table
 *   for every plugin in a batch — `loadPlugins` with twenty plugins rebuilt it
 *   twenty times, and any request arriving mid-batch paid for a rebuild.
 * - **Fail-closed**, because a handle is a promise. `loadPlugin` resolving has
 *   to mean bound AND lifecycle-started AND served; anything weaker makes the
 *   return value untrustworthy and pushes the check onto every caller, who will
 *   not write it. Reporting the failure in a side-channel is the same lie with
 *   extra steps — especially since the logger it used is debug-namespaced and
 *   silent by default.
 *
 * Rolling back here is safe and complete: the servers validate their candidate
 * surface before committing to it (see `RestServer.refreshSurface`), so a
 * failure means that server did not change, and `inverse()` undoes the
 * bindings and lifecycle of the mount that prompted it.
 *
 * @param inverse the mount's teardown, run when any server failed.
 * @throws a `PluginLoadError`-carrying Error when any server failed to refresh.
 */
export async function commitSurfaces(
  app: Application,
  packageName: string,
  inverse: () => Promise<void>,
  onRolledBack?: () => void,
): Promise<void> {
  const failures = await refreshSurfaces(app);
  if (!failures.length) return;

  // The refresh failure is the diagnosis; a teardown that ALSO fails is extra
  // damage that must not replace it, so it is attached rather than thrown.
  let teardownError: unknown;
  try {
    await inverse();
  } catch (err) {
    teardownError = err;
  }
  onRolledBack?.();

  const error: PluginLoadError = {
    package: packageName,
    kind: 'surface-refresh',
    message:
      `mounted, but the server(s) could not serve it: ` +
      `${describeSurfaceFailures(failures)}. The mount was rolled back` +
      `${teardownError === undefined ? '' : ', and the rollback ALSO failed'}.`,
  };
  const e = new Error(
    `[plugin:${error.package}] ${error.kind}: ${error.message}`,
  ) as Error & {error?: PluginLoadError; rollbackFailure?: unknown};
  e.error = error;
  if (teardownError !== undefined) e.rollbackFailure = teardownError;
  throw e;
}
