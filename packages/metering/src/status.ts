// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {UsageStatus} from './types.js';

/**
 * Map a thrown error to a billing-relevant {@link UsageStatus}. `undefined`
 * (the success path) is `ok`; HTTP error codes are bucketed so the usage log
 * distinguishes "the caller was refused" (`denied` / `rate_limited` /
 * `payment_required`) from "the call failed" (`error`). Only `ok` bills by
 * default.
 */
export function statusOf(err: unknown): UsageStatus {
  if (!err) return 'ok';
  const code =
    (err as {statusCode?: number}).statusCode ??
    (err as {status?: number}).status;
  switch (code) {
    case 401:
    case 403:
      return 'denied';
    case 402:
      return 'payment_required';
    case 429:
      return 'rate_limited';
    default:
      return 'error';
  }
}
