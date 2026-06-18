// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  securityId,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {AuthenticationResult} from '@agentback/authentication';
import createError from 'http-errors';

/**
 * The principal-bearing claims shared by an RFC 7662 introspection response and
 * an OAuth2 JWT access token. Everything is optional and source-dependent; the
 * index signature carries through custom claims.
 */
export interface PrincipalClaims {
  /** Subject — the resource owner's stable id (absent for client tokens). */
  sub?: unknown;
  /** Client id the token was issued to (client-credentials grant). */
  client_id?: unknown;
  /** Human-readable identifier for the resource owner. */
  username?: unknown;
  /** Space-delimited scope string (RFC 7662 §2.2 / RFC 9068). */
  scope?: unknown;
  /** Array scope form used by some issuers (e.g. Azure AD `scp`). */
  scp?: unknown;
  [claim: string]: unknown;
}

/**
 * Token-framing claims that describe the token, not the principal — stripped
 * from the surfaced profile. `scope`/`scp` are removed too because they are
 * re-exposed, normalized, as `scopes` / `allowedScopes`.
 */
const FRAMING_CLAIMS = [
  'active',
  'exp',
  'iat',
  'nbf',
  'token_type',
  'scope',
  'scp',
] as const;

/** Normalize the granted scopes from either the string `scope` or array `scp`. */
export function normalizeScopes(claims: PrincipalClaims): string[] {
  if (Array.isArray(claims.scp)) return claims.scp.map(String);
  if (typeof claims.scope === 'string') {
    return claims.scope.split(' ').filter(Boolean);
  }
  return [];
}

/** Copy claims minus the framing/scope fields. */
function principalAttributes(claims: PrincipalClaims): Record<string, unknown> {
  const out: Record<string, unknown> = {...claims};
  for (const claim of FRAMING_CLAIMS) delete out[claim];
  return out;
}

/**
 * Map validated OAuth2 token claims onto the framework's principal model. A
 * token with a `sub` (resource owner) becomes `{user}` with the granted scopes
 * on `scopes`; a token with only a `client_id` (client-credentials grant)
 * becomes `{clientApplication}` with the scopes on `allowedScopes`. An active
 * token that names neither is rejected (401) — there is no principal to bind a
 * request to.
 *
 * Shared by the opaque-introspection and JWT access-token strategies so both
 * surface identical principals.
 */
export function claimsToAuthResult(
  claims: PrincipalClaims,
): AuthenticationResult {
  const scopes = normalizeScopes(claims);
  const attributes = principalAttributes(claims);

  if (claims.sub != null && claims.sub !== '') {
    const user: UserProfile = {
      ...attributes,
      [securityId]: String(claims.sub),
      name:
        typeof claims.username === 'string'
          ? claims.username
          : String(claims.sub),
      scopes,
    };
    return {user};
  }

  if (claims.client_id != null && claims.client_id !== '') {
    const clientApplication: ClientApplication = {
      ...attributes,
      [securityId]: String(claims.client_id),
      name: String(claims.client_id),
      allowedScopes: scopes,
    };
    return {clientApplication};
  }

  throw createError(401, 'Token identifies neither a user nor a client.');
}
