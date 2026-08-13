// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The revertible-install contract (docs/proposals/revertible-installs.md):
 * every `install*` helper returns its inverse, so a mounted capability's
 * footprint is a value the caller can retract instead of a sequence of side
 * effects only `app.stop()` can end.
 */
export interface Installed {
  /**
   * Revert every registration this install performed, in reverse order.
   * Idempotent: a second call is a no-op. Reverts registrations only — side
   * effects that already crossed the process boundary (requests served,
   * events emitted) stay.
   */
  uninstall(): Promise<void>;
}

/**
 * Unbind `binding`'s key only if that exact binding is still the one bound —
 * the identity-guarded inverse of a bind. `Context.bind()` REPLACES an
 * existing binding at the same key, so an uninstall that blindly unbinds by
 * key would remove a binding the user (or a reinstall) has since shadowed
 * over ours. Ownership, not key possession, is what an inverse may retract.
 */
export function unbindOwned(
  ctx: {
    isBound(key: string): boolean;
    getBinding(key: string): unknown;
    unbind(key: string): boolean;
  },
  binding: {key: string},
): void {
  if (ctx.isBound(binding.key) && ctx.getBinding(binding.key) === binding) {
    ctx.unbind(binding.key);
  }
}
