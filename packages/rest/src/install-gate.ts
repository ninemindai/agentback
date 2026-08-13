// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RequestHandler} from 'express';

/**
 * One liveness flag for an install's Express footprint
 * (docs/proposals/revertible-installs.md): Express cannot unmount a layer,
 * so every registration a revertible `install*` helper makes shares a gate
 * that its `uninstall()` flips off.
 */
export interface InstallGate {
  /**
   * Route-chain gate: mount as the FIRST handler of every METHOD chain
   * (ahead of parsers and other side-effecting middleware). Dead →
   * `next('route')` falls through to the app's 404.
   */
  readonly gate: RequestHandler;
  /**
   * Wrap a middleware for `app.use(...)` chains: dead → plain `next()`
   * pass-through (`next('route')` has no route to skip in a use-layer).
   */
  wrap(mw: RequestHandler): RequestHandler;
  /** Flip the gate off. Idempotent — push onto the install's teardown. */
  off(): void;
}

export function installGate(): InstallGate {
  let live = true;
  return {
    gate: (_req, _res, next) => (live ? next() : next('route')),
    wrap: mw => (req, res, next) => (live ? mw(req, res, next) : next()),
    off: () => {
      live = false;
    },
  };
}
