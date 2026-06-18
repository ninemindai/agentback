// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  securityId,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {AuthRequest} from './auth-request.js';

/**
 * Authentication metadata attached by the `@authenticate` decorator.
 */
export interface AuthenticationMetadata {
  /** Name of the strategy (e.g. 'jwt', 'basic'). */
  strategy: string;
  /** Per-call options forwarded to the strategy. */
  options?: Record<string, unknown>;
  /** When true, the route bypasses authentication entirely. */
  skip?: boolean;
}

/**
 * Result of a successful authentication. A strategy may return a bare
 * `UserProfile` (shorthand for `{user}`) or this richer shape to also surface
 * the resolved client application — bound into the request context so
 * authorization scope governance can read it.
 */
export interface AuthenticationResult {
  user?: UserProfile;
  clientApplication?: ClientApplication;
}

/**
 * Authentication strategy contract. Implementations look at the request,
 * verify the supplied credentials, and return a UserProfile (or an
 * {@link AuthenticationResult}) if the request is authenticated. Throwing
 * converts to a 401 in the REST server.
 */
export interface AuthenticationStrategy {
  /** Unique identifier (matches the `@authenticate(<name>)` argument). */
  name: string;
  authenticate(
    request: AuthRequest,
    options?: Record<string, unknown>,
  ): Promise<UserProfile | AuthenticationResult | undefined>;
}

/** Function form used by the REST interceptor. */
export type AuthenticateFn = (
  request: AuthRequest,
) => Promise<UserProfile | undefined>;

/**
 * Sentinel profile for a request that is known-but-unauthenticated. Returned
 * by the {@link AnonymousAuthenticationStrategy} so public/optional-auth
 * routes are first-class instead of throwing 401.
 */
export const ANONYMOUS_USER: UserProfile = {
  [securityId]: '$anonymous',
  name: 'anonymous',
};

/**
 * Validates an API key and resolves it to a user. Bind one under
 * {@link API_KEY_VERIFIER} to enable {@link ApiKeyAuthenticationStrategy}.
 * Return `undefined` (or throw) to reject the key.
 */
export type ApiKeyVerifier = (
  apiKey: string,
  request: AuthRequest,
) => Promise<UserProfile | undefined> | UserProfile | undefined;

/**
 * Validates client credentials and resolves them to a {@link ClientApplication}.
 * Bind one under {@link CLIENT_CREDENTIALS_VERIFIER} to enable
 * {@link ClientCredentialsAuthenticationStrategy}. Return `undefined` (or
 * throw) to reject the credentials.
 */
export type ClientCredentialsVerifier = (
  clientId: string,
  clientSecret: string,
  request: AuthRequest,
) => Promise<ClientApplication | undefined> | ClientApplication | undefined;
