// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AsyncLocalStorage} from 'node:async_hooks';
import type {PrincipalRef} from '@agentback/metering';

/**
 * Per-unit-of-work accounting state for the model calls made inside it.
 *
 * The reliability policies (retry, breaker, fallback) need nothing from the
 * caller — the params carry the abort signal and the breaker's state is
 * app-level. The ACCOUNTING policies do: a usage event needs a principal, and a
 * budget needs somewhere to keep the running total. A model is usually
 * constructed once at boot (a singleton agent holds it), so that state cannot
 * be captured at wrap time — it has to be ambient.
 */
export interface ModelScope {
  /** Who to bill. Absent means anonymous — the same answer an unauthenticated call gets. */
  principal?: PrincipalRef;
  /** Groups this scope's events with the turn/request that produced them. */
  correlationId?: string;
  /** Token ceiling for everything called inside this scope. */
  tokenBudget?: number;
  /** Running total, mutated by the metering policy as calls complete. */
  tokensSpent: number;
}

const storage = new AsyncLocalStorage<ModelScope>();

/**
 * Run `fn` with an ambient {@link ModelScope}. Every model call made inside —
 * at any depth, across awaits — bills to it.
 *
 * `@agentback/agents` enters one per turn, so the common path (a singleton
 * agent behind a per-request DI wrapper) gets per-principal token accounting
 * without the model having to know which request it is serving.
 */
export function withModelScope<T>(
  scope: Omit<ModelScope, 'tokensSpent'> & {tokensSpent?: number},
  fn: () => T,
): T {
  return storage.run({tokensSpent: 0, ...scope}, fn);
}

/** The ambient scope, or `undefined` outside one. */
export function currentModelScope(): ModelScope | undefined {
  return storage.getStore();
}
