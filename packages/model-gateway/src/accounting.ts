// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {Meter, PrincipalRef} from '@agentback/metering';
import {TokenBudgetExceededError} from './errors.js';
import {servingModel} from './fallback.js';
import {currentModelScope, type ModelScope} from './scope.js';
import {
  modelLabel,
  totalTokens,
  type ModelGenerateResult,
  type ModelMiddleware,
  type ModelStreamResult,
  type ModelUsage,
} from './types.js';

const log = loggers('agentback:model-gateway:accounting');

const ANONYMOUS: PrincipalRef = {kind: 'anonymous', id: 'anon'};

export interface AccountingOptions {
  /** Where usage events go. Omit to account tokens without emitting events. */
  meter?: Meter;
  /**
   * A model call is billed in TOKENS, not calls — the whole reason this policy
   * exists. One request can be 500 tokens or 500,000, so a per-call counter
   * describes traffic and says nothing about spend.
   */
  operation?: string;
}

/**
 * Token accounting for every model call: emits one `'agent'`-surface usage
 * event whose `units` are total tokens, and enforces the ambient scope's
 * `tokenBudget`.
 *
 * The budget is checked BEFORE the call (a scope already over its ceiling
 * never reaches the provider) and the spend is added after, so each call may
 * overshoot by one response — the provider decides how many tokens it emits,
 * and a bounded overshoot beats pretending we can predict it. Calls running
 * in parallel within one scope each pass the check before any has reported,
 * so each of them may overshoot by one response. The check covers every
 * enclosing scope's budget, and the spend is added to all of them.
 *
 * The scope is captured when the call STARTS: a stream is usually consumed,
 * and cancelled, outside the scope that opened it.
 */
export function accountingPolicy(
  opts: AccountingOptions = {},
): ModelMiddleware {
  const operation = opts.operation ?? 'model.call';

  const preflight = (scope: ModelScope | undefined): void => {
    for (let s = scope; s; s = s.parent) {
      if (s.tokenBudget !== undefined && s.tokensSpent >= s.tokenBudget) {
        const err = new TokenBudgetExceededError(s.tokensSpent, s.tokenBudget);
        // Kept for a streamed caller, which sees this only as a stream part.
        scope!.refused = err;
        throw err;
      }
    }
  };

  const settle = async (
    scope: ModelScope | undefined,
    usage: ModelUsage | undefined,
    label: string,
    startedAt: number,
    status: 'ok' | 'error',
  ): Promise<void> => {
    const tokens = totalTokens(usage);
    for (let s = scope; s; s = s.parent) s.tokensSpent += tokens;
    if (!opts.meter) return;
    await opts.meter
      .record({
        surface: 'agent',
        operation,
        principal: scope?.principal ?? ANONYMOUS,
        units: tokens,
        status,
        latencyMs: Date.now() - startedAt,
        meta: {
          model: label,
          inputTokens: usage?.inputTokens?.total,
          outputTokens: usage?.outputTokens?.total,
          cachedInputTokens: usage?.inputTokens?.cacheRead,
          ...(scope?.correlationId ? {correlationId: scope.correlationId} : {}),
        },
      })
      .catch(err => log.warn('failed to record model usage: %O', err));
  };

  return {
    async wrapGenerate({doGenerate, model}) {
      const scope = currentModelScope();
      preflight(scope);
      const startedAt = Date.now();
      const label = modelLabel(model);
      try {
        const result = (await doGenerate()) as ModelGenerateResult;
        // Bill the model that answered: after a failover that is not `model`.
        const served = servingModel.get(result) ?? label;
        await settle(scope, result.usage, served, startedAt, 'ok');
        return result;
      } catch (err) {
        // A failed call still burned input tokens at the provider in most
        // cases, but we have no report of them — record the attempt with zero
        // units rather than inventing a number.
        await settle(scope, undefined, label, startedAt, 'error');
        throw err;
      }
    },

    async wrapStream({doStream, model}) {
      const scope = currentModelScope();
      preflight(scope);
      const startedAt = Date.now();
      const label = modelLabel(model);
      let result: ModelStreamResult & {stream?: ReadableStream<unknown>};
      try {
        result = (await doStream()) as typeof result;
      } catch (err) {
        await settle(scope, undefined, label, startedAt, 'error');
        throw err;
      }
      if (!result.stream) return result;
      const served = servingModel.get(result) ?? label;

      // Usage on a stream is only knowable at the END, in the `finish` part.
      // Tap the stream rather than skipping streamed calls — streaming is the
      // common case for agents, so metering that ignored it would miss most of
      // the bill.
      let usage: ModelUsage | undefined;
      let finished = false;
      let errored = false;
      let settled = false;
      const finish = (status: 'ok' | 'error') => {
        if (settled) return;
        settled = true;
        void settle(scope, usage, served, startedAt, status);
      };

      const tap = new TransformStream<unknown, unknown>({
        transform(part, controller) {
          const p = part as {type?: string; usage?: ModelUsage};
          if (p?.type === 'finish') {
            finished = true;
            if (p.usage) usage = p.usage;
          }
          if (p?.type === 'error') errored = true;
          controller.enqueue(part);
        },
        // A stream that reported an error, or ended without its `finish`, did
        // not complete, whatever it billed.
        flush() {
          finish(finished && !errored ? 'ok' : 'error');
        },
        // A consumer that walks away mid-stream still spent what it spent.
        cancel() {
          finish('error');
        },
      });

      return {
        ...result,
        stream: result.stream.pipeThrough(tap),
      } as ModelStreamResult;
    },
  };
}
