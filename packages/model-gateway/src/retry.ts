// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {CircuitOpenError, TokenBudgetExceededError} from './errors.js';
import type {ModelMiddleware} from './types.js';

const log = loggers('agentback:model-gateway:retry');

/** HTTP statuses worth trying again. Everything else is the caller's fault. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** First backoff step in ms; doubles per attempt. Default 500. */
  baseDelayMs?: number;
  /**
   * Ceiling for one backoff, before jitter. Default 30_000. A provider
   * `Retry-After` longer than this is not waited out: the call fails at once.
   */
  maxDelayMs?: number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter factor in [0.5, 1.5), for deterministic tests. */
  jitter?: () => number;
}

/** Pull an HTTP status off whatever shape the provider threw. */
function statusOf(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const e = err as {statusCode?: unknown; status?: unknown};
  const raw = e.statusCode ?? e.status;
  return typeof raw === 'number' ? raw : undefined;
}

/**
 * `Retry-After` in ms when the provider told us how long to wait: either
 * delta-seconds or an HTTP-date. A moment already past means "now".
 */
function retryAfterMs(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const headers = (err as {responseHeaders?: Record<string, string>})
    .responseHeaders;
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * Sleep, but end the wait the moment the caller aborts: someone who hung up
 * during a 30s backoff should not hold the call open for the rest of it.
 * Raced here rather than trusted to `sleep`, so an injected sleep that ignores
 * the signal still cannot delay an abort.
 */
function pause(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, {once: true});
    sleep(ms, signal)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Whether an error is worth another attempt.
 *
 * The rule is *retry the transport, never the reasoning*. A 429, a dropped
 * socket, a 503 — those are the network having a bad second. A 400, a content
 * filter, a context-length overflow: the same request will fail the same way
 * forever, and paying for it three times is strictly worse than failing once.
 *
 * Pass the caller's `abortSignal`: a call the caller cancelled is never
 * retried, whatever it threw. Cancellation is read off the SIGNAL, not the
 * error — an abort-shaped error (`AbortError`, `TimeoutError`) says nothing
 * about who aborted, and one the caller did not ask for, such as a provider
 * `fetch` wrapper's own `AbortSignal.timeout`, is the transport failing.
 */
export function isRetryable(err: unknown, callerSignal?: AbortSignal): boolean {
  // A cancelled call must never come back: someone asked for it to stop. The
  // AI SDK folds its own `timeout` into this signal, so that counts too.
  if (callerSignal?.aborted) return false;
  // Our own control-flow errors are decisions, not failures.
  if (err instanceof CircuitOpenError) return false;
  if (err instanceof TokenBudgetExceededError) return false;
  // An abort nobody here asked for is the transport giving up on us.
  if (isAbortShaped(err)) return true;

  const status = statusOf(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  // No status: a transport-level failure (DNS, reset socket, timeout). The AI
  // SDK marks these on APICallError; absent that, a plain Error with no status
  // is more likely a bug in our code than a provider blip, so don't retry.
  const e = err as {isRetryable?: unknown; name?: unknown};
  if (typeof e.isRetryable === 'boolean') return e.isRetryable;
  return false;
}

function isAbortShaped(err: unknown): boolean {
  const name = (err as {name?: unknown} | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Retry with exponential backoff and jitter.
 *
 * Jitter is not decoration: without it every instance in a fleet retries on the
 * same schedule, and a brief provider throttle becomes a self-inflicted
 * thundering herd that keeps the provider down. `Retry-After` wins when the
 * provider states one, unless it exceeds `maxDelayMs`: retrying before the
 * provider allows just earns another 429, so the call fails now and a
 * fallback can act on it.
 */
export function retryPolicy(opts: RetryOptions = {}): ModelMiddleware {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const sleep: (ms: number, signal?: AbortSignal) => Promise<void> =
    opts.sleep ??
    ((ms, signal) =>
      new Promise<void>(resolve => {
        // An abandoned backoff must not keep a timer (and the process) alive,
        // and a finished one must not leave its listener on the signal.
        const stop = () => clearTimeout(timer);
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', stop);
          resolve();
        }, ms);
        signal?.addEventListener('abort', stop, {once: true});
      }));
  const jitter = opts.jitter ?? (() => 0.5 + Math.random());

  const run = async <T>(
    call: () => PromiseLike<T>,
    signal: AbortSignal | undefined,
    label: string,
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // Re-check between attempts: a caller who left during the backoff should
      // not be charged for the next try.
      if (signal?.aborted) throw signal.reason;
      try {
        return await call();
      } catch (err) {
        lastError = err;
        if (!isRetryable(err, signal) || attempt === attempts - 1) throw err;
        const after = retryAfterMs(err);
        if (after !== undefined && after > maxDelayMs) {
          log.warn(
            '%s asked to wait %dms, over maxDelayMs %dms — not retrying',
            label,
            after,
            maxDelayMs,
          );
          throw err;
        }
        const backoff = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        const delay = after ?? Math.round(backoff * jitter());
        log.warn(
          '%s attempt %d/%d failed (%s) — retrying in %dms',
          label,
          attempt + 1,
          attempts,
          (err as Error)?.message ?? err,
          delay,
        );
        await pause(sleep, delay, signal);
      }
    }
    throw lastError;
  };

  return {
    wrapGenerate: ({doGenerate, params, model}) =>
      run(doGenerate, params.abortSignal, `generate ${model.modelId ?? '?'}`),
    wrapStream: ({doStream, params, model}) =>
      run(doStream, params.abortSignal, `stream ${model.modelId ?? '?'}`),
  };
}
