// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import type {UserProfile} from '@agentback/security';

/** Built-in pseudo-roles. */
export const EVERYONE = '$everyone';
export const AUTHENTICATED = '$authenticated';
export const UNAUTHENTICATED = '$unauthenticated';

/**
 * Voter decision. ABSTAIN passes the decision down the chain; if all voters
 * abstain, the default action is DENY.
 */
export enum AuthorizationDecision {
  ALLOW = 'Allow',
  DENY = 'Deny',
  ABSTAIN = 'Abstain',
}

/** Attached by the `@authorize` decorator (class or method level). */
export interface AuthorizationMetadata {
  allowedRoles?: string[];
  deniedRoles?: string[];
  /** Required scopes (all must be present in the principal's scopes). */
  scopes?: string[];
  /** Extra voters that run before the default role/scope check. */
  voters?: Authorizer[];
  /** Resource name shown in error messages; defaults to Controller.method. */
  resource?: string;
  /** Bypass authorization for this route. */
  skip?: boolean;
}

/** Per-request authorization context built by the REST interceptor. */
export interface AuthorizationContext {
  /** Principal IDs derived from the authenticated user. Empty when anonymous. */
  principals: string[];
  /** Effective role names for the principal. Empty when anonymous. */
  roles: string[];
  /** Effective scope strings (e.g. OAuth scopes from a JWT). */
  scopes: string[];
  /** Resource identifier, e.g. `WidgetController.cancelOrder`. */
  resource: string;
  /** The authenticated user, if any (undefined for anonymous requests). */
  user?: UserProfile;
  /**
   * The per-request invocation context. Set by {@link runAuthorization} so
   * voters can read request-scoped bindings (e.g. the current tenant or a
   * client application deposited by an authentication strategy).
   */
  invocationContext?: Context;
}

/**
 * A function that returns ALLOW, DENY, or ABSTAIN for an authorization
 * request. Voters compose left-to-right; first definitive decision wins.
 */
export type Authorizer = (
  ctx: AuthorizationContext,
  meta: AuthorizationMetadata,
) => Promise<AuthorizationDecision> | AuthorizationDecision;
