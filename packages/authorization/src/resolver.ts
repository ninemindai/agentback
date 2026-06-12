// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {MetadataInspector} from '@agentback/metadata';
import {securityId, type UserProfile} from '@agentback/security';
import {AuthorizationKeys, GLOBAL_VOTER_TAG} from './keys.js';
import {
  AuthorizationDecision,
  AUTHENTICATED,
  EVERYONE,
  UNAUTHENTICATED,
  type AuthorizationContext,
  type AuthorizationMetadata,
  type Authorizer,
} from './types.js';

/** Method-level @authorize wins; otherwise class-level. */
export function getAuthorizationMetadata(
  controllerCtor: Function,
  methodName: string | symbol,
): AuthorizationMetadata | undefined {
  const methodMeta = MetadataInspector.getMethodMetadata<AuthorizationMetadata>(
    AuthorizationKeys.METADATA,
    controllerCtor.prototype,
    String(methodName),
  );
  if (methodMeta) return methodMeta;
  return MetadataInspector.getClassMetadata<AuthorizationMetadata>(
    AuthorizationKeys.CLASS_METADATA,
    controllerCtor,
  );
}

/** Build an AuthorizationContext from a (possibly absent) UserProfile. */
export function buildAuthorizationContext(
  user: UserProfile | undefined,
  resource: string,
): AuthorizationContext {
  if (!user) {
    return {principals: [], roles: [], scopes: [], resource};
  }
  const userWithExtras = user as UserProfile & {
    roles?: string[];
    scopes?: string[] | string;
  };
  const scopes = Array.isArray(userWithExtras.scopes)
    ? userWithExtras.scopes
    : typeof userWithExtras.scopes === 'string'
      ? userWithExtras.scopes.split(' ').filter(Boolean)
      : [];
  return {
    principals: [user[securityId]],
    roles: userWithExtras.roles ?? [],
    scopes,
    resource,
    user,
  };
}

/**
 * Default role/scope voter: enforces `deniedRoles`, then `allowedRoles`,
 * then `scopes`. Pseudo-roles `$everyone`, `$authenticated`, and
 * `$unauthenticated` are recognized.
 */
export const defaultRoleVoter: Authorizer = (ctx, meta) => {
  const isAuthenticated = ctx.principals.length > 0;
  const effectiveRoles = new Set<string>(ctx.roles);
  effectiveRoles.add(EVERYONE);
  if (isAuthenticated) effectiveRoles.add(AUTHENTICATED);
  else effectiveRoles.add(UNAUTHENTICATED);

  if (meta.deniedRoles?.some(r => effectiveRoles.has(r))) {
    return AuthorizationDecision.DENY;
  }
  if (meta.allowedRoles?.length) {
    const allowed = meta.allowedRoles.some(r => effectiveRoles.has(r));
    if (!allowed) return AuthorizationDecision.DENY;
  }
  if (meta.scopes?.length) {
    const granted = new Set(ctx.scopes);
    const missing = meta.scopes.some(s => !granted.has(s));
    if (missing) return AuthorizationDecision.DENY;
  }
  // No applicable rule -> abstain so other voters can decide
  const hasAnyRule =
    !!meta.allowedRoles?.length ||
    !!meta.deniedRoles?.length ||
    !!meta.scopes?.length;
  return hasAnyRule
    ? AuthorizationDecision.ALLOW
    : AuthorizationDecision.ABSTAIN;
};

/**
 * Run the voter chain: per-route voters first, then globals bound under
 * `GLOBAL_VOTER_TAG`, then the default role/scope voter. Returns the first
 * non-ABSTAIN decision; defaults to DENY if every voter abstains.
 */
export async function runAuthorization(
  ctx: AuthorizationContext,
  meta: AuthorizationMetadata,
  context: Context,
): Promise<AuthorizationDecision> {
  const inline = meta.voters ?? [];
  const globalBindings = context.findByTag(GLOBAL_VOTER_TAG);
  const globals: Authorizer[] = [];
  for (const b of globalBindings) {
    globals.push(await context.get<Authorizer>(b.key));
  }
  // Expose the invocation context to voters (e.g. tenant/client-app checks)
  // without changing the public Authorizer signature.
  const enriched: AuthorizationContext = {...ctx, invocationContext: context};
  const voters = [...inline, ...globals, defaultRoleVoter];
  for (const v of voters) {
    const decision = await v(enriched, meta);
    if (decision !== AuthorizationDecision.ABSTAIN) return decision;
  }
  return AuthorizationDecision.DENY;
}
