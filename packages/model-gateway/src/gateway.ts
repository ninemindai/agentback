// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Meter} from '@agentback/metering';
import {accountingPolicy} from './accounting.js';
import {CircuitBreaker, breakerPolicy, type BreakerOptions} from './breaker.js';
import {fallbackPolicy, type FallbackOptions} from './fallback.js';
import {retryPolicy, type RetryOptions} from './retry.js';
import type {LanguageModelLike, ModelMiddleware} from './types.js';

export interface GatewayOptions {
  /** Token accounting + budget enforcement. Pass a `Meter` to emit events. */
  accounting?: {meter?: Meter; operation?: string} | false;
  /** Fail over to other providers. Off unless models are given. */
  fallback?: FallbackOptions;
  /** Transport retries. `false` to disable; defaults on. */
  retry?: RetryOptions | false;
  /** Circuit breaker. Pass a shared instance, options, or `false`. */
  breaker?: CircuitBreaker | BreakerOptions | false;
}

/**
 * Assemble the gateway's middleware, outermost first.
 *
 * The order is the design, not a detail:
 *
 * ```
 * accounting  → budget refuses before spending; sees the whole logical call,
 *               retries included, so one call bills once
 *   fallback  → outside retry (a blip retries the primary, it does not
 *               change providers) and outside the breaker (or the secondary's
 *               success would be recorded as the primary's health)
 *     retry   → transport blips only; never the reasoning
 *       breaker → per PHYSICAL attempt, so retries vote on health and a
 *                 tripped circuit makes the remaining ones fail fast
 *         provider
 * ```
 *
 * `wrapLanguageModel` applies the first middleware as the outermost wrapper,
 * so this array is already in the right order for it.
 */
export function gatewayMiddleware(
  opts: GatewayOptions = {},
): ModelMiddleware[] {
  const stack: ModelMiddleware[] = [];

  if (opts.accounting !== false) {
    stack.push(accountingPolicy(opts.accounting ?? {}));
  }
  if (opts.fallback) stack.push(fallbackPolicy(opts.fallback));
  if (opts.retry !== false) stack.push(retryPolicy(opts.retry ?? {}));
  if (opts.breaker !== false) {
    const breaker =
      opts.breaker instanceof CircuitBreaker
        ? opts.breaker
        : new CircuitBreaker(opts.breaker ?? {});
    stack.push(breakerPolicy(breaker));
  }
  return stack;
}

/**
 * Wrap a language model with the gateway.
 *
 * The returned model is a drop-in for the original — `generateText`,
 * `streamText`, `ToolLoopAgent` and `@agentback/agents` all keep working, and
 * every call they make now goes through the policies. That is the whole reason
 * this is middleware and not a new `gateway.call()` API: a seam the agent
 * runtime routes around protects nothing.
 *
 * `ai` is an OPTIONAL peer dependency, imported lazily here — a service that
 * never wraps a model never loads it.
 */
export async function wrapModel<M extends LanguageModelLike>(
  model: M,
  opts: GatewayOptions = {},
): Promise<M> {
  const {wrapLanguageModel} = await import('ai');
  return wrapLanguageModel({
    model: model as never,
    middleware: gatewayMiddleware(opts) as never,
  }) as unknown as M;
}
