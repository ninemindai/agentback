// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * A LIFO stack of disposers backing the revertible-install contract
 * (docs/proposals/revertible-installs.md): mount steps `push` their inverse,
 * and `run()` replays the inverses in reverse registration order.
 */
export interface Teardown {
  /** Register one disposer. */
  push(dispose: () => void | Promise<void>): void;
  /**
   * Run all registered disposers in reverse order. Idempotent: a second call
   * is a no-op. A failing disposer does not stop the rest; failures are
   * aggregated into a single rejected `AggregateError`.
   */
  run(): Promise<void>;
}

export function composeTeardown(): Teardown {
  const disposers: Array<() => void | Promise<void>> = [];
  return {
    push(dispose) {
      disposers.push(dispose);
    },
    async run() {
      // Drain the stack up front: a second run() sees an empty list (idempotent)
      // and a disposer that itself pushes cannot loop the drain.
      const drained = disposers.splice(0).reverse();
      const failures: unknown[] = [];
      for (const dispose of drained) {
        try {
          await dispose();
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, 'teardown failed');
      }
    },
  };
}
