// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Fetch} from '@agentback/common';
import type {CallbackFailureReason} from '@agentback/mcp';

/** One outbound webhook POST. */
export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  /** The exact bytes that were signed. Sent verbatim. */
  body: string;
  /** Per-attempt wall clock, connect to last response byte. */
  timeoutMs: number;
  signal?: AbortSignal;
}

/** The endpoint's answer: the status and (a capped prefix of) the body. */
export interface WebhookResponse {
  status: number;
  body: string;
}

/**
 * Sends one webhook POST. It never follows a redirect: a 3xx comes back as a
 * response like any other non-2xx. Connection-level failures throw a
 * {@link TransportError} carrying a {@link CallbackFailureReason}.
 */
export type WebhookTransport = (
  req: WebhookRequest,
) => Promise<WebhookResponse>;

/**
 * A connection-level failure, classified into the categories the protocol
 * lets a server report. Never carries the endpoint's own words.
 */
export class TransportError extends Error {
  constructor(
    readonly reason: Extract<
      CallbackFailureReason,
      'connection_refused' | 'timeout' | 'tls_error'
    >,
    message: string,
    options?: {cause?: unknown},
  ) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/** The failure category for a non-2xx status (a 3xx counts as a 4xx). */
export function statusReason(status: number): 'http_4xx' | 'http_5xx' {
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

/** Default cap on how much of a response body is read (64 KiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * A {@link WebhookTransport} over a platform `fetch`, for hosts without
 * `node:https` (Workers, Deno, Bun) — **it cannot pin the resolved IP.** The
 * platform resolves the name at connect time and offers no hook to check the
 * address it picked, so a callback hostname that rebinds to an internal
 * address after subscribe-time checks is not caught here. Prefer
 * {@link createPinnedTransport} on Node; on an edge host, restrict egress at
 * the platform instead. Redirects are still refused (`redirect: 'manual'`).
 */
export function fetchTransport(
  fetchImpl: Fetch = globalThis.fetch,
  opts: {maxResponseBytes?: number} = {},
): WebhookTransport {
  const max = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return async req => {
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const signal = req.signal
      ? AbortSignal.any([req.signal, timeout])
      : timeout;
    let res: Response;
    try {
      res = await fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
        signal,
      });
    } catch (err) {
      if (timeout.aborted) {
        throw new TransportError('timeout', 'webhook request timed out', {
          cause: err,
        });
      }
      throw new TransportError(
        'connection_refused',
        'webhook request failed to connect',
        {cause: err},
      );
    }
    // An opaque redirect reports status 0; surface it as the 3xx it was.
    const status = res.type === 'opaqueredirect' ? 302 : res.status;
    const text = await readCapped(res, max);
    return {status, body: text};
  };
}

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const {done, value} = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(size, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  return new TextDecoder().decode(all);
}
