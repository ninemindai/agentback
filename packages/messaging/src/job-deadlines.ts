// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AbortReasons, abortError, loggers} from '@agentback/common';

const log = loggers('agentback:messaging:deadline');

/**
 * Per-attempt cancellation and wall-clock budget, shared by every `JobQueue`
 * adapter so the two behave identically.
 *
 * An agent job has no natural end. A retry/recursion cap counts turns, and a
 * run stalled *between* turns — a provider holding a socket, a tool waiting on
 * a connection — stops counting while it keeps billing. A clock is the only
 * thing that ends that, so `timeoutMs` is the backstop.
 *
 * The deadline **abandons** the attempt; it does not kill it. Nothing in Node
 * can interrupt a running handler, so on elapse we abort the signal (the
 * cooperative half — a handler that passed it to `fetch` stops paying at once),
 * record the attempt as failed, and free the slot. A handler that ignores its
 * signal keeps running to completion in the background with nobody reading its
 * result. That is the same bargain `@agentback/actors` strikes for a turn
 * deadline, and for the same reason.
 */
export class JobDeadlines {
  private readonly live = new Map<string, AbortController>();
  /**
   * Every abort reason this registry issued. Terminality is decided by
   * identity against this set, never by the error's name: a handler's own
   * `AbortSignal.timeout()` fetch throws a `TimeoutError` too, and that is an
   * ordinary failure the job's `attempts` should retry.
   */
  private readonly issued = new WeakSet<object>();

  /**
   * Run one attempt of `job` under `timeoutMs`, with a signal that also fires
   * if {@link abort} names this job first.
   *
   * Rejects with a `DOMException` named `AbortError` when the attempt is
   * abandoned — {@link isAbandonment} recognizes it, and an adapter must treat
   * it as terminal. Redelivering an abandoned attempt re-runs work someone asked
   * to stop, and on a deadline it means the same hang costs the same money on
   * the next worker, and the one after that.
   */
  async run(
    id: string,
    timeoutMs: number | undefined,
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    this.live.set(id, controller);
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            log.warn(
              'job %s abandoned after %dms — the handler may still be running',
              id,
              timeoutMs,
            );
            this.abandon(controller, AbortReasons.DEADLINE);
          }, timeoutMs);
    // Unref so a pending deadline never holds the process open on shutdown.
    timer?.unref?.();

    // The abandonment path must not wait on `work`: the whole point is that a
    // stalled handler never returns. Racing a promise that settles on `abort`
    // frees the slot on time regardless of what the handler does next.
    const abandoned = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason),
        {once: true},
      );
    });
    // No sink is needed on either input. `Promise.race` subscribes to every
    // promise it is given at call time, so a loser that rejects LATER — the
    // abandoned handler finally throwing, or `abandoned` rejecting after the
    // handler already returned — is still a handled rejection. Verified
    // against plain Node, not assumed.
    try {
      await Promise.race([work(controller.signal), abandoned]);
    } finally {
      clearTimeout(timer);
      this.live.delete(id);
    }
  }

  /**
   * Abort an attempt currently running **in this process**, returning whether
   * one was found. Cross-process cancellation is not implied: a worker in
   * another process holds its own registry and is unreachable from here.
   */
  abort(id: string, reason: string = AbortReasons.CANCELLED): boolean {
    const controller = this.live.get(id);
    if (!controller) return false;
    this.abandon(controller, reason);
    return true;
  }

  /**
   * Whether `err` is an abandonment this registry issued — the retry decision.
   * An abandoned attempt must not be retried; any other error, however it is
   * shaped, is the handler failing and follows the job's `attempts`.
   */
  isAbandonment(err: unknown): boolean {
    return typeof err === 'object' && err !== null && this.issued.has(err);
  }

  private abandon(controller: AbortController, reason: string): void {
    const error = abortError(reason);
    this.issued.add(error);
    controller.abort(error);
  }

  /** Whether an attempt for `id` is running in this process. */
  has(id: string): boolean {
    return this.live.has(id);
  }
}
