// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AbortReasons, abortError} from '@agentback/common';

/**
 * The slice of a Node `ServerResponse` this module needs. Typed structurally so
 * the module stays free of the `express` types — it is reached from the Web
 * pipeline too.
 */
interface ClosableResponse {
  on(event: 'close', listener: () => void): unknown;
  readonly writableEnded: boolean;
}

/**
 * A signal that aborts when the client hangs up on a Node response.
 *
 * `close` fires on BOTH outcomes — the response finished, or the socket died —
 * so `writableEnded` is what separates them: it is true only once we wrote the
 * last byte ourselves. Without that guard every completed request would abort
 * its own signal on the way out, killing any background work the handler
 * handed it to.
 */
export function nodeAbortSignal(res: ClosableResponse): AbortSignal {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      controller.abort(abortError(AbortReasons.CALLER_GONE));
    }
  });
  return controller.signal;
}

/**
 * Re-express a host's abort signal as one of ours.
 *
 * Every fetch host aborts `Request.signal` on a disconnect, but each with its
 * own reason — `@hono/node-server`, workerd, Bun and Deno do not agree on the
 * error, and a route cannot be written against four of them. Linking to a
 * fresh controller normalizes the reason to {@link AbortReasons.CALLER_GONE}
 * on every host, at the cost of one listener per request.
 */
export function linkedAbortSignal(source: AbortSignal): AbortSignal {
  if (source.aborted) {
    return AbortSignal.abort(abortError(AbortReasons.CALLER_GONE));
  }
  const controller = new AbortController();
  source.addEventListener(
    'abort',
    () => controller.abort(abortError(AbortReasons.CALLER_GONE)),
    {once: true},
  );
  return controller.signal;
}
