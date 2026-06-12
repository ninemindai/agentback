// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {
  securityId,
  SecurityBindings,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {AuthenticationResult} from '@agentback/authentication';
import type {PrincipalRef} from './types.js';

/** The sentinel principal for an unauthenticated/anonymous call. */
export const ANONYMOUS: PrincipalRef = {kind: 'anonymous', id: '$anonymous'};

/**
 * Derive a billable {@link PrincipalRef} from a REST authentication result — a
 * `{user}` becomes a `user` principal, a `{clientApplication}` becomes a
 * `client` principal, and an empty result is anonymous.
 */
export function principalFromAuth(
  auth: AuthenticationResult | undefined,
): PrincipalRef {
  if (auth?.user) return {kind: 'user', id: String(auth.user[securityId])};
  if (auth?.clientApplication) {
    return {kind: 'client', id: String(auth.clientApplication[securityId])};
  }
  return ANONYMOUS;
}

/**
 * Derive a {@link PrincipalRef} from an MCP `AuthInfo` (bound at
 * `MCPBindings.REQUEST_AUTH`). Prefers the resolved principal in `extra`
 * (set by the framework-strategy guard); falls back to the OAuth2 `clientId`.
 */
export function principalFromAuthInfo(
  auth: {clientId?: string; extra?: Record<string, unknown>} | undefined,
): PrincipalRef {
  const user = auth?.extra?.user as UserProfile | undefined;
  if (user) return {kind: 'user', id: String(user[securityId])};
  const app = auth?.extra?.clientApplication as ClientApplication | undefined;
  if (app) return {kind: 'client', id: String(app[securityId])};
  if (auth?.clientId) return {kind: 'client', id: auth.clientId};
  return ANONYMOUS;
}

/**
 * Derive a {@link PrincipalRef} from a per-request context after the
 * dispatch pipeline ran — auth binds `SecurityBindings.USER` /
 * `.CLIENT_APPLICATION` into it with constant values, so a synchronous read
 * is safe at record time.
 */
export function principalFromContext(ctx: Context): PrincipalRef {
  const user = ctx.getSync(SecurityBindings.USER, {optional: true});
  if (user) return {kind: 'user', id: String(user[securityId])};
  const client = ctx.getSync(SecurityBindings.CLIENT_APPLICATION, {
    optional: true,
  });
  if (client) return {kind: 'client', id: String(client[securityId])};
  return ANONYMOUS;
}
