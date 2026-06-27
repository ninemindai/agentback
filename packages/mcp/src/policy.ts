// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {getAuthorizationMetadata} from '@agentback/authorization';
import {
  securityId,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';
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
  };
  return {user};
}

/**
 * The scopes a session must hold for a tool to be *visible* (registered for
 * `tools/list` / `tools/call`).
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
  meta: ToolMetadata,
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
