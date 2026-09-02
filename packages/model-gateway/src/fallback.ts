// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {isAbortError, loggers} from '@agentback/common';
import {TokenBudgetExceededError} from './errors.js';
import {
  modelLabel,
  type LanguageModelLike,
  type ModelMiddleware,
} from './types.js';

const log = loggers('agentback:model-gateway:fallback');

export interface FallbackOptions {
  /** Models to try, in order, after the primary fails. */
  models: LanguageModelLike[];
  /**
   * Whether a given failure should fail over. Default: anything that is not a
   * cancellation, a budget refusal, or a 4xx that is not 408/409/429 — i.e.
   * "the provider let us down", not "the request was wrong".
   */
  shouldFailover?: (err: unknown) => boolean;
}

function defaultShouldFailover(err: unknown): boolean {
  // Our own decisions are not provider failures.
  if (isAbortError(err)) return false;
  if (err instanceof TokenBudgetExceededError) return false;
  const status =
    (err as {statusCode?: number; status?: number})?.statusCode ??
    (err as {status?: number})?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // A malformed request fails identically everywhere; trying a second
    // provider just buys the same 400 twice. Throttling is the exception.
    return status === 408 || status === 409 || status === 429;
  }
  return true;
}

/**
 * Fail over to a secondary provider.
 *
 * Place it OUTSIDE the breaker and the retry policy. Outside retry, because a
 * one-second blip should be retried on the primary, not answered by a
 * different model. Outside the breaker, because if fallback ran underneath it
 * the secondary's success would be recorded as the primary's health and the
 * circuit would never trip.
 *
 * The price is discipline: keep prompts and tools to the INTERSECTION of what
 * both providers support, and eval on both. A fallback you have never
 * exercised is decoration, not resilience.
 */
export function fallbackPolicy(opts: FallbackOptions): ModelMiddleware {
  const shouldFailover = opts.shouldFailover ?? defaultShouldFailover;

  const run = async <T>(
    primary: () => PromiseLike<T>,
    secondaries: Array<() => PromiseLike<T>>,
    primaryLabel: string,
  ): Promise<T> => {
    try {
      return await primary();
    } catch (err) {
      if (!shouldFailover(err)) throw err;
      let lastError = err;
      for (let i = 0; i < secondaries.length; i++) {
        const label = modelLabel(opts.models[i]);
        log.warn(
          'failing over from %s to %s: %s',
          primaryLabel,
          label,
          (lastError as Error)?.message ?? lastError,
        );
        try {
          return await secondaries[i]();
        } catch (nextErr) {
          lastError = nextErr;
          if (!shouldFailover(nextErr)) throw nextErr;
        }
      }
      throw lastError;
    }
  };

  return {
    wrapGenerate: ({doGenerate, params, model}) =>
      run(
        doGenerate,
        opts.models.map(
          m => () =>
            (
              m as unknown as {
                doGenerate(o: unknown): PromiseLike<never>;
              }
            ).doGenerate(params),
        ),
        modelLabel(model),
      ),
    wrapStream: ({doStream, params, model}) =>
      run(
        doStream,
        opts.models.map(
          m => () =>
            (
              m as unknown as {
                doStream(o: unknown): PromiseLike<never>;
              }
            ).doStream(params),
        ),
        modelLabel(model),
      ),
  };
}
