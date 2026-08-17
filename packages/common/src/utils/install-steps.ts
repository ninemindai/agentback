// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from './debug-factory.js';
import {composeTeardown, type Teardown} from './teardown.js';

const log = loggers('agentback:common:install-steps');

/** One step's inverse, yielded by an install generator as the step lands. */
export type Disposer = () => void | Promise<void>;

/**
 * Drive a multi-step install whose steps yield their own inverses.
 *
 * The generator body performs a step and then `yield`s the disposer for THAT
 * step, so an inverse exists for every step that has landed at every
 * suspension point. When a later step throws, the already-yielded disposers
 * run in LIFO order and the original error is rethrown — the caller writes no
 * rollback `catch` at all.
 *
 * This is the structural form of a rule `install*` helpers already follow by
 * hand (docs/proposals/revertible-installs.md, composition rule): a helper
 * that fails partway must not leave its completed steps mounted. Written as
 * `try/catch → teardown.run() → throw`, that discipline is re-implemented at
 * every early exit, and any region outside a `try` is silently uncovered.
 * Written as a generator, coverage is a property of the calling convention.
 *
 * Yield placement is load-bearing: hand over a step's inverse BEFORE running
 * anything that can throw on what the step produced, so the throw rolls that
 * step back instead of leaking it.
 *
 * ```ts
 * const {value, teardown} = await installSteps(async function* () {
 *   const gate = installGate();
 *   yield () => gate.off();          // inverse handed over before the mount
 *   server.expressApp.use(base, gate.wrap(handler));
 *   return {base};
 * });
 * ```
 *
 * @returns the generator's return value plus the populated {@link Teardown},
 * so the caller composes it into whatever `Installed` shape it publishes.
 */
export async function installSteps<R>(
  steps: () => AsyncGenerator<Disposer, R, void>,
): Promise<{value: R; teardown: Teardown}> {
  const teardown = composeTeardown();
  const iter = steps();
  try {
    // Collect each disposer BEFORE resuming the body. That ordering is the
    // whole guarantee: the step after a yield can never run un-covered.
    let next = await iter.next();
    while (!next.done) {
      teardown.push(next.value);
      next = await iter.next();
    }
    return {value: next.value, teardown};
  } catch (err) {
    await revert(teardown, err);
    throw err;
  }
}

/**
 * Roll back after a failed install.
 *
 * The install's own error stays the thrown value and keeps its type — a
 * rollback that also fails must not replace the caller's diagnosis with a
 * different error class at the worst possible moment.
 *
 * But it must not be hidden either, and `loggers()` alone cannot carry it:
 * every level is a debug sub-namespace, so `log.error` emits NOTHING unless
 * `DEBUG` matches. A log-only rollback failure is indistinguishable from the
 * `.catch(() => {})` this replaced. So the failure is attached to the error the
 * caller already has, two ways that survive with zero configuration: appended
 * to `message` (which every printer shows) and exposed as `rollbackFailure`
 * for programmatic inspection. `cause` is set only when the install error left
 * it unset, so an existing cause chain is never clobbered.
 */
async function revert(teardown: Teardown, cause: unknown): Promise<void> {
  try {
    await teardown.run();
  } catch (err) {
    log.error(
      'rollback after a failed install left registrations behind: %O (install error: %O)',
      err,
      cause,
    );
    if (cause instanceof Error) {
      (cause as Error & {rollbackFailure?: unknown}).rollbackFailure = err;
      if (cause.cause === undefined) cause.cause = err;
      cause.message += ` [rollback also failed: ${describeFailure(err)}]`;
    }
  }
}

/**
 * `composeTeardown.run()` rejects with an `AggregateError` whose own message is
 * the constant `'teardown failed'` — useless in a message that exists to say
 * WHAT failed. Unwrap to the individual disposer errors.
 */
function describeFailure(err: unknown): string {
  if (err instanceof AggregateError) {
    return err.errors
      .map(e => (e instanceof Error ? e.message : String(e)))
      .join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}
