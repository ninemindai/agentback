// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {AuthInfo} from '@modelcontextprotocol/server';

import {getAuthorizationMetadata} from '@agentback/authorization';
import {
  securityId,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {ToolMetadata} from './keys.js';

/**
 * Principals derived from a transport-level `AuthInfo`. Mirrors the shape the
 * REST layer's authentication strategies produce so the same authorization
 * voter chain works on both surfaces.
 */
export interface McpPrincipals {
  user?: UserProfile;
  clientApplication?: ClientApplication;
}

/**
 * Map the MCP SDK's `AuthInfo` onto the framework's principal model.
 *
 * - `frameworkAuthGuard` (mcp-http) already deposits framework principals at
 *   `authInfo.extra.user` / `authInfo.extra.clientApplication` — used as-is.
 * - Otherwise (a raw OAuth verifier), a `UserProfile` is synthesized from the
 *   claims: `securityId = clientId`, `scopes = authInfo.scopes`, so scope
 *   checks in `@authorize({scopes})` work without extra wiring.
 */
export function authInfoToPrincipals(authInfo: AuthInfo): McpPrincipals {
  const extra = (authInfo.extra ?? {}) as {
    user?: UserProfile;
    clientApplication?: ClientApplication;
  };
  if (extra.user || extra.clientApplication) {
    return {user: extra.user, clientApplication: extra.clientApplication};
  }
  const user: UserProfile = {
    [securityId]: authInfo.clientId,
    scopes: authInfo.scopes,
    [SYNTHESIZED_PRINCIPAL]: true,
  };
  return {user};
}

/**
 * Marks a `UserProfile` that {@link authInfoToPrincipals} synthesized from a
 * token's `clientId` because the token carried no user. Under OAuth that id
 * names the client **application** (ChatGPT, Claude) — shared by every one of
 * its end users — so it identifies no one in particular.
 */
export const SYNTHESIZED_PRINCIPAL = Symbol.for(
  'agentback.mcp.synthesizedPrincipal',
);

/**
 * True for a principal synthesized from a token's `clientId` (see
 * {@link SYNTHESIZED_PRINCIPAL}). Per-user state — settings, preferences,
 * anything keyed "per user" — must not be keyed on such a principal: every
 * user of the same host would share one bucket.
 */
export function isSynthesizedPrincipal(user: unknown): boolean {
  return (
    typeof user === 'object' &&
    user !== null &&
    (user as Record<symbol, unknown>)[SYNTHESIZED_PRINCIPAL] === true
  );
}

/**
 * Marks the `MCPServerConfig.localPrincipal` fallback as bound for a request:
 * an identity the server's own config asserted, the same for every caller the
 * transport admits — not one a request proved.
 */
export const LOCAL_PRINCIPAL = Symbol.for('agentback.mcp.localPrincipal');

/** The id the `anonymous` authentication strategy gives an unauthenticated caller. */
const ANONYMOUS_ID = '$anonymous';

/**
 * True only for a principal that identifies **one person the request proved**:
 * a user an authentication strategy supplied, or one an in-process caller
 * passed explicitly. False for no principal, the `anonymous` strategy's
 * sentinel, a principal synthesized from a token's `clientId`
 * ({@link isSynthesizedPrincipal}), and the `localPrincipal` config fallback.
 * Key per-user state (settings, preferences) only on a verified principal.
 */
export function isVerifiedPrincipal(user: unknown): user is UserProfile {
  if (typeof user !== 'object' || user === null) return false;
  const u = user as Record<string | symbol, unknown>;
  if (u[SYNTHESIZED_PRINCIPAL] === true || u[LOCAL_PRINCIPAL] === true) {
    return false;
  }
  const id = u[securityId];
  return typeof id === 'string' && id !== '' && id !== ANONYMOUS_ID;
}

/**
 * The scopes a session must hold for a tool to be *visible* (registered for
 * `tools/list` / `tools/call`). `@event` types share the rule: their `scope`
 * option gates `events/list` and `events/subscribe` the same way.
 *
 * Source order: `@authorize({scopes})` on the method (with class-level
 * fallback, same resolver REST uses) > the legacy `@tool(..., {scope})`
 * single-scope option. `@authorize.skip` yields unconditional visibility.
 *
 * Roles/voters in `@authorize` metadata are deliberately NOT consulted here:
 * they need a principal-specific evaluation that doesn't fit list-time, so
 * such tools stay visible and are denied at call time.
 */
export function requiredScopesForTool(
  ctor: Function,
  meta: Pick<ToolMetadata, 'methodName' | 'scope'>,
): string[] {
  const fromAuthz = requiredScopesForMember(ctor, meta.methodName as string);
  if (fromAuthz.length) return fromAuthz;
  const authz = getAuthorizationMetadata(ctor, meta.methodName as string);
  if (authz?.skip) return [];
  return meta.scope ? [meta.scope] : [];
}

/**
 * The scopes a session must hold for a class member (resource/prompt/tool
 * method) to be *visible*, from `@authorize({scopes})` metadata only —
 * resources and prompts have no legacy per-decorator scope option.
 * Same semantics as tools: `skip` → unconditional, roles/voters → visible
 * but enforced at call time.
 */
export function requiredScopesForMember(
  ctor: Function,
  methodName: string,
): string[] {
  const authz = getAuthorizationMetadata(ctor, methodName);
  if (authz?.skip) return [];
  return authz?.scopes?.length ? authz.scopes : [];
}
