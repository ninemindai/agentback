// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Standard reasons an in-flight unit of work is aborted. They are messages,
 * not codes: the reason travels as the `AbortSignal.reason` and surfaces in
 * logs, so it has to read as an explanation on its own.
 */
export const AbortReasons = {
  /** The caller hung up — nobody is waiting for this answer any more. */
  CALLER_GONE: 'The caller disconnected before the work finished.',
  /** A wall-clock budget elapsed. The backstop for a run that never returns. */
  DEADLINE: 'The deadline elapsed before the work finished.',
  /** An explicit cancel — an operator, or the caller asking to stop. */
  CANCELLED: 'The work was cancelled.',
} as const;

/**
 * Build the `AbortSignal.reason` for an aborted unit of work. A `DOMException`
 * named `AbortError` is the web-standard shape: `fetch`, `Request`, and the AI
 * SDK all rethrow it verbatim, so a cancelled model call surfaces as one
 * recognizable error rather than three per-library ones.
 */
export function abortError(message: string): DOMException {
  return new DOMException(message, 'AbortError');
}

/**
 * Whether an error is shaped like an abort — ours (`AbortError`), a platform
 * timeout (`TimeoutError`, e.g. from `AbortSignal.timeout()`), or a legacy
 * `ABORT_ERR` code. Use it to keep an expected stop out of error logs.
 *
 * It is NOT the retry decision. The shape says nothing about WHO aborted: a
 * handler's own `fetch(url, {signal: AbortSignal.timeout(n)})` timing out is
 * an ordinary, retryable failure. Only the owner of the signal knows it
 * stopped the work — a job queue asks its own deadline registry, by identity.
 */
export function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const {name, code} = err as {name?: unknown; code?: unknown};
  return (
    name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR'
  );
}
