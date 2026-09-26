// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {TokenBudgetExceededError} from './errors.js';
import {
  modelLabel,
  type LanguageModelLike,
  type ModelMiddleware,
} from './types.js';

const log = loggers('agentback:model-gateway:fallback');

/**
 * Which secondary served a call, keyed by the result object the fallback
 * policy returned. The accounting policy reads it so spend is attributed to
 * the model that sent the bill, not the primary that failed. Absent means the
 * primary served.
 */
export const servingModel = new WeakMap<object, string>();

export interface FallbackOptions {
  /** Models to try, in order, after the primary fails. */
  models: LanguageModelLike[];
  /**
   * Whether a given failure should fail over. Default: anything that is not a
   * budget refusal or a 4xx that is not 408/409/429 — i.e. "the provider let
   * us down", not "the request was wrong". Never consulted once the caller has
   * cancelled: that is checked on the call's own signal first.
   */
  shouldFailover?: (err: unknown) => boolean;
}

function defaultShouldFailover(err: unknown): boolean {
  // Our own decisions are not provider failures. (A provider timing out on its
  // own IS one, so an abort-shaped error with no status falls through.)
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
    callerSignal: AbortSignal | undefined,
  ): Promise<T> => {
    // The caller left: asking another provider spends money on an answer
    // nobody is waiting for. Read off the signal, not the error's shape.
    const failover = (e: unknown) =>
      !callerSignal?.aborted && shouldFailover(e);
    try {
      return await primary();
    } catch (err) {
      if (!failover(err)) throw err;
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
          const result = await secondaries[i]();
          if (typeof result === 'object' && result !== null) {
            servingModel.set(result, label);
          }
          return result;
        } catch (nextErr) {
          lastError = nextErr;
          if (!failover(nextErr)) throw nextErr;
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
        params.abortSignal,
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
        params.abortSignal,
      ),
  };
}
