// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {promisify} from 'util';
import {loggers} from './debug-factory.js';

const {trace, error} = loggers('loopback:promise');

/**
 * Resolve a promise with timeout
 * @param timeoutMs - Timeout in milliseconds
 * @param promise - Promise to be resolved or a function that returns a promise
 * @param failureMessage - Custom error message for timeout
 */
export function resolvePromiseWithTimeout<T>(
  promise: Promise<T> | (() => Promise<T>),
  timeoutMs?: number,
  failureMessage?: string,
) {
  if (timeoutMs == null) {
    return typeof promise === 'function' ? promise() : promise;
  }
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((resolve, reject) => {
    timeoutHandle = setTimeout(
      () =>
        reject(
          new Error(failureMessage ?? `Timeout in ${timeoutMs} milliseconds`),
        ),
      timeoutMs,
    );
  });

  if (typeof promise === 'function') {
    promise = promise();
  }
  return Promise.race([promise, timeoutPromise]).then(result => {
    clearTimeout(timeoutHandle);
    return result;
  });
}

/**
 * Sleep function
 */
export const sleep = promisify(setTimeout);

/**
 * Exponential backoff strategy for retries
 * @param base - Base wait time in milliseconds
 */
export function exponentialBackoff(base: number) {
  return (retries: number) => {
    return base * Math.pow(2, retries);
  };
}

/**
 * Options for retry
 */
export type RetryOptions<T = unknown> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  shouldRetry?: (err?: any, data?: T) => boolean;
  waitInMs?: number | ((retries: number) => number);
  maxRetries?: number;
};

/**
 * Run a task with retry it if fails
 * @param fn - Task function
 * @param options - Retry options
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions<T>,
) {
  const shouldRetry = options?.shouldRetry ?? ((err, data) => err != null);
  const waitInMs = options?.waitInMs ?? exponentialBackoff(50);
  const maxRetries = options?.maxRetries ?? 5;
  let retries = 0;
  let wait = 0;
  for (;;) {
    try {
      trace('Trying #%d', retries);
      const result = await fn();
      trace('Result', result);
      if (!shouldRetry(undefined, result) || retries >= maxRetries) {
        return result;
      }
      // Let's retry
    } catch (err) {
      error('Error: %O', err);
      if (retries >= maxRetries) {
        error('Maximum number of retries (%d) has been reached', retries);
        // Max number of retries reached
        throw err;
      }
      if (!shouldRetry(err)) {
        // Let's fail
        error('No retry should happen: %O', err);
        throw err;
      }
    }
    if (typeof waitInMs === 'function') {
      wait = waitInMs(retries);
    } else {
      wait = waitInMs;
    }
    trace('Waiting for %d milliseconds before next retry', wait);
    await sleep(wait);
    ++retries;
  }
}
