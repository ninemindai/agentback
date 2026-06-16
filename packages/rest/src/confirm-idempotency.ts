// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import createError from 'http-errors';
import {ErrorCodes, type RouteSchemas} from '@agentback/openapi';
import {
  stableStringify,
  type ConfirmationStore,
  type IdempotencyStore,
} from '@agentback/common';

/**
 * Runtime-neutral confirmation + idempotency primitives shared by the Express
 * {@link RestServer} and the Web {@link RestHandler} so the two surfaces can't
 * drift. Each helper is parameterized on a plain request shape
 * ({@link RequestFacts}), a header accessor, and the relevant store — the
 * Express path feeds them `req.method`/`req.path`/`req.params`/`req.query`/
 * `req.body` + `req.get`, the Web path feeds them the URL pathname,
 * `match.params`, the once-read query/body + `req.headers.get`.
 */

/** The request facts a confirmation fingerprint is built from. */
export interface RequestFacts {
  method: string;
  path: string;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

/** Case-insensitive single-header accessor (Express `req.get`, Web `headers.get`). */
export type HeaderGetter = (name: string) => string | null | undefined;

/**
 * `confirm:` enforcement (transport-neutral). The first call (no
 * `x-confirmation-token` header) throws a 409 `confirmation_required` carrying
 * a single-use token bound to the exact request fingerprint; the identical
 * retry with the token resolves; a mismatched/expired token throws a 409
 * `confirmation_invalid`. The thrown errors are `http-errors` instances with
 * `.code` (and `.confirmationToken` on the first), so {@link buildErrorEnvelope}
 * renders the identical envelope on both surfaces.
 */
export async function enforceConfirmation(opts: {
  scope: string;
  facts: RequestFacts;
  getHeader: HeaderGetter;
  store: ConfirmationStore;
  confirm: NonNullable<RouteSchemas['confirm']>;
}): Promise<void> {
  const {scope, facts, getHeader, store, confirm} = opts;
  const fingerprint = stableStringify(facts);
  const token = getHeader('x-confirmation-token');
  if (!token) {
    const ttlMs = typeof confirm === 'object' ? confirm.ttlMs : undefined;
    const issued = store.issue(scope, fingerprint, ttlMs);
    const e = createError(
      409,
      'This operation requires confirmation. Retry the identical request ' +
        "with the issued token in the 'x-confirmation-token' header.",
    );
    const agentErr = e as createError.HttpError & {
      code: string;
      confirmationToken: string;
    };
    agentErr.code = ErrorCodes.CONFIRMATION_REQUIRED;
    agentErr.confirmationToken = issued;
    throw e;
  }
  if (!store.verify(token, scope, fingerprint)) {
    const e = createError(
      409,
      'The confirmation token is invalid, expired, or was issued for a ' +
        'different request payload.',
    );
    (e as createError.HttpError & {code: string}).code =
      ErrorCodes.CONFIRMATION_INVALID;
    throw e;
  }
}

/**
 * `idempotency:` replay (transport-neutral). Replaying an `idempotency-key`
 * returns the original result without re-running `run`; without the header the
 * operation runs normally unless `{required: true}` (then a 400
 * `idempotency_key_required` is thrown). Returns `{replayed, result}` — the
 * caller surfaces `replayed` as the `idempotency-replayed: true` response
 * header (Express `res.setHeader`, Web response header).
 */
export async function executeIdempotent(opts: {
  scope: string;
  getHeader: HeaderGetter;
  store: IdempotencyStore;
  idempotency: NonNullable<RouteSchemas['idempotency']>;
  run: () => Promise<unknown>;
}): Promise<{replayed: boolean; result: unknown}> {
  const {scope, getHeader, store, idempotency, run} = opts;
  const cfg = typeof idempotency === 'object' ? idempotency : {};
  const key = getHeader('idempotency-key');
  if (!key) {
    if (cfg.required) {
      const e = createError(
        400,
        "This operation requires an 'idempotency-key' header.",
      );
      (e as createError.HttpError & {code: string}).code =
        ErrorCodes.IDEMPOTENCY_KEY_REQUIRED;
      throw e;
    }
    return {replayed: false, result: await run()};
  }
  return store.execute(`${scope}:${key}`, run, cfg.ttlMs);
}
