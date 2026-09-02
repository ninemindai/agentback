// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Thrown by the breaker while the circuit is open. Distinct from a provider
 * error on purpose: the retry policy must NOT retry it (a fail-fast rejection
 * is the breaker doing its job, and retrying it just burns the budget), while
 * the fallback policy MUST catch it — an open circuit is precisely when a
 * secondary provider earns its keep.
 */
export class CircuitOpenError extends Error {
  readonly code = 'circuit_open';
  constructor(
    readonly target: string,
    readonly retryAfterMs: number,
  ) {
    super(
      `Circuit open for '${target}' — not calling it for another ${retryAfterMs}ms.`,
    );
    this.name = 'CircuitOpenError';
  }
}

/**
 * Thrown when a unit of work exceeds its token budget. A bounded failure beats
 * an unbounded bill: the caller sees a typed error naming what it spent, not a
 * surprise invoice.
 */
export class TokenBudgetExceededError extends Error {
  readonly code = 'token_budget_exceeded';
  constructor(
    readonly spent: number,
    readonly budget: number,
  ) {
    super(`Token budget exceeded: spent ${spent} of ${budget}.`);
    this.name = 'TokenBudgetExceededError';
  }
}
