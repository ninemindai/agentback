// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {CircuitOpenError} from './errors.js';
import {isRetryable} from './retry.js';
import {modelLabel, type ModelMiddleware} from './types.js';

const log = loggers('agentback:model-gateway:breaker');

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Consecutive failures that trip the circuit. Default 5. */
  threshold?: number;
  /** How long to stay open before probing. Default 30_000ms. */
  resetAfterMs?: number;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

/**
 * Per-target circuit breaker.
 *
 * When a provider degrades, pulling more work makes it strictly worse: every
 * caller pays the full timeout, sockets pile up, and a single sick dependency
 * stalls the process. The breaker's job is to stop calling something that is
 * known to be down and fail immediately instead — which is what lets a queue
 * back up harmlessly rather than convert a ten-minute blip into a wave of
 * permanent failures.
 *
 * Shared state, so bind ONE instance per app and let every wrapped model use
 * it: a breaker whose counters reset per request has no memory and therefore
 * no opinion.
 */
export class CircuitBreaker {
  private readonly threshold: number;
  private readonly resetAfterMs: number;
  private readonly now: () => number;
  private readonly circuits = new Map<
    string,
    {failures: number; openedAt?: number; probing?: boolean}
  >();

  constructor(opts: BreakerOptions = {}) {
    this.threshold = opts.threshold ?? 5;
    this.resetAfterMs = opts.resetAfterMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private circuitFor(target: string) {
    let c = this.circuits.get(target);
    if (!c) this.circuits.set(target, (c = {failures: 0}));
    return c;
  }

  /** Current state of a target's circuit. */
  state(target: string): CircuitState {
    const c = this.circuits.get(target);
    // `=== undefined`, not falsy: an injected clock can legitimately report 0,
    // and `!0` would call a tripped circuit closed.
    if (c?.openedAt === undefined) return 'closed';
    return this.now() - c.openedAt >= this.resetAfterMs ? 'half-open' : 'open';
  }

  /** Throws {@link CircuitOpenError} when the target must not be called. */
  assertClosed(target: string): void {
    const c = this.circuitFor(target);
    if (c.openedAt === undefined) return;
    const elapsed = this.now() - c.openedAt;
    if (elapsed < this.resetAfterMs) {
      throw new CircuitOpenError(target, this.resetAfterMs - elapsed);
    }
    // Half-open: let exactly ONE probe through. Releasing the whole backlog at
    // once is how a recovering provider gets knocked over a second time.
    if (c.probing) throw new CircuitOpenError(target, this.resetAfterMs);
    c.probing = true;
  }

  /** Record a successful call — closes the circuit. */
  recordSuccess(target: string): void {
    const c = this.circuitFor(target);
    if (c.openedAt !== undefined) {
      log.info('circuit for %s recovered — closing', target);
    }
    c.failures = 0;
    c.openedAt = undefined;
    c.probing = false;
  }

  /**
   * Record an outcome that says nothing about the provider's health (a 400, a
   * content filter, a cancelled call). It must not count as a failure — that
   * would let one caller's bad input trip the circuit for everyone — and it
   * must not count as a success either, since the provider was never proven
   * well. It only releases a half-open probe slot, so a rejected probe does
   * not wedge the circuit shut forever.
   */
  recordNeutral(target: string): void {
    this.circuitFor(target).probing = false;
  }

  /** Record a failed call; trips the circuit at the threshold. */
  recordFailure(target: string): void {
    const c = this.circuitFor(target);
    c.probing = false;
    c.failures++;
    if (c.failures >= this.threshold && c.openedAt === undefined) {
      c.openedAt = this.now();
      log.error(
        'circuit for %s OPEN after %d consecutive failures — pausing calls for %dms',
        target,
        c.failures,
        this.resetAfterMs,
      );
    } else if (c.openedAt !== undefined) {
      // The probe failed. Restart the cooldown rather than probing in a loop.
      c.openedAt = this.now();
    }
  }
}

/**
 * Only a failure that says something about the PROVIDER's health should move
 * the breaker. A 400 or a content filter is the request being wrong and would
 * fail against a perfectly healthy provider; counting it would trip the
 * circuit on a caller's bad input and take down everyone else. A caller's
 * cancel is their decision, not the provider's health — but a provider that
 * times out on its own is exactly the outage this exists to catch. So the
 * breaker counts exactly what the retry policy retries.
 */
function countsAgainstHealth(
  err: unknown,
  callerSignal: AbortSignal | undefined,
): boolean {
  return isRetryable(err, callerSignal);
}

/**
 * Circuit-breaker middleware. Place it INSIDE the retry policy: each physical
 * attempt then votes on the provider's health, and once the circuit opens the
 * remaining retries fail fast instead of hammering a sick provider.
 *
 * Streaming caveat: `doStream` resolves once the response STARTS, so a stream
 * that dies mid-body is not counted here — only failures to obtain the stream
 * are. The stream's own `error` parts are surfaced to the caller unchanged.
 */
export function breakerPolicy(breaker: CircuitBreaker): ModelMiddleware {
  const guard = async <T>(
    target: string,
    call: () => PromiseLike<T>,
    callerSignal: AbortSignal | undefined,
  ): Promise<T> => {
    breaker.assertClosed(target);
    try {
      const result = await call();
      breaker.recordSuccess(target);
      return result;
    } catch (err) {
      if (countsAgainstHealth(err, callerSignal)) {
        breaker.recordFailure(target);
      } else breaker.recordNeutral(target);
      throw err;
    }
  };

  return {
    wrapGenerate: ({doGenerate, params, model}) =>
      guard(modelLabel(model), doGenerate, params.abortSignal),
    wrapStream: ({doStream, params, model}) =>
      guard(modelLabel(model), doStream, params.abortSignal),
  };
}
