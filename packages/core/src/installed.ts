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

/** The subset of `Context` a revert needs. */
interface RevertableContext {
  isBound(key: string): boolean;
  getBinding(key: string): unknown;
  unbind(key: string): boolean;
  add(binding: never): unknown;
}

/**
 * Retract a binding we own: unbind it, and restore whatever it displaced.
 *
 * ONE identity check gates BOTH halves, and that is the point. `Context.bind()`
 * REPLACES an existing binding at the same key, so an uninstall that blindly
 * unbinds removes a binding the user (or a reinstall) has since shadowed over
 * ours — and an uninstall that blindly *restores* is the same hazard mirrored,
 * overwriting that shadow with a stale binding. Ownership, not key possession,
 * is what an inverse may retract; when the key is no longer ours, nothing
 * happens at all.
 *
 * @returns `true` when the binding was still ours (unbound, and `displaced`
 * restored when given); `false` when the context was left untouched.
 */
export function revertOwned(
  ctx: RevertableContext,
  binding: {key: string},
  displaced?: {key: string},
): boolean {
  if (!ctx.isBound(binding.key)) return false;
  if (ctx.getBinding(binding.key) !== binding) return false;
  ctx.unbind(binding.key);
  if (displaced !== undefined) ctx.add(displaced as never);
  return true;
}

/**
 * Unbind `binding`'s key only if that exact binding is still the one bound —
 * the identity-guarded inverse of a bind. Thin wrapper over
 * {@link revertOwned} with no displaced binding to restore.
 */
export function unbindOwned(
  ctx: RevertableContext,
  binding: {key: string},
): void {
  revertOwned(ctx, binding);
}
