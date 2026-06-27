// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  SecurityBindings,
  type ClientApplication,
} from '@agentback/security';
import {AuthorizationDecision, type Authorizer} from './types.js';

/** Scope sentinels recognized by {@link areScopesAllowed}. */
export const SCOPE_ALL = 'ALL';
/** A scope that requires no authentication/governance. */
export const SCOPE_PUBLIC = 'PUBLIC';
/** Internal-only scope; `ALL` does NOT grant it — it must be listed explicitly. */
export const SCOPE_INTERNAL = 'INTERNAL';

/**
 * Decide whether a client application is permitted to use the requested scopes.
 *
 * Semantics:
 * - No requested scopes, or only `PUBLIC` → allowed.
 * - No client application bound → allowed (user-only endpoint; the user's own
 *   scopes are still enforced by {@link defaultRoleVoter}).
 * - `disallowedScopes` takes precedence: a requested scope listed there (or
 *   `disallowedScopes` containing `ALL`) → denied.
 * - `INTERNAL` is only granted when `allowedScopes` lists it explicitly.
 * - Otherwise a scope is allowed when `allowedScopes` is omitted, contains
 *   `ALL`, or lists the scope.
 */
export function areScopesAllowed(
  clientApp: ClientApplication | undefined,
  requestedScopes: string[] | Set<string> | undefined,
): boolean {
  const requested = [...(requestedScopes ?? [])];
  if (requested.length === 0) return true;
  if (requested.every(s => s === SCOPE_PUBLIC)) return true;
  if (!clientApp) return true;

  const allowed = clientApp.allowedScopes ?? [SCOPE_ALL];
  const disallowed = clientApp.disallowedScopes ?? [];

  for (const scope of requested) {
    if (scope === SCOPE_PUBLIC) continue;
    if (disallowed.includes(SCOPE_ALL) || disallowed.includes(scope)) {
      return false;
    }
    if (scope === SCOPE_INTERNAL) {
      if (!allowed.includes(SCOPE_INTERNAL)) return false;
      continue;
    }
    if (allowed.includes(SCOPE_ALL) || allowed.includes(scope)) continue;
    return false;
  }
  return true;
}

/**
 * Voter enforcing client-application scope governance. Reads the current
 * client application from the request context
 * ({@link SecurityBindings.CLIENT_APPLICATION}) and DENYs when it is not
 * permitted to use the route's required scopes; otherwise ABSTAINs (so the
 * user's own scopes are still checked by {@link defaultRoleVoter}).
 *
 * Enable it globally by binding it under `GLOBAL_VOTER_TAG`, or add it to a
 * route's `voters`.
 */
export const clientAppScopeVoter: Authorizer = async (ctx, meta) => {
  const required = meta.scopes ?? [];
  if (required.length === 0) return AuthorizationDecision.ABSTAIN;
  const ic = ctx.invocationContext;
  const clientApp = ic
    ? await ic.get(SecurityBindings.CLIENT_APPLICATION, {optional: true})
    : undefined;
  if (!clientApp) return AuthorizationDecision.ABSTAIN;
  return areScopesAllowed(clientApp, required)
    ? AuthorizationDecision.ABSTAIN
    : AuthorizationDecision.DENY;
};
