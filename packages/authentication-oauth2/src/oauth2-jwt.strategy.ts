// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ContextTags, inject, injectable} from '@agentback/context';
import {
  AuthenticationBindings,
  type AuthRequest,
  type AuthenticationResult,
  type AuthenticationStrategy,
} from '@agentback/authentication';
import {OAuth2JwtBindings} from './keys.js';
import type {JwtAccessTokenService} from './jwt-access-token.service.js';
import {claimsToAuthResult, type PrincipalClaims} from './principal-mapping.js';
import {extractBearerToken} from './bearer.js';

/**
 * Authentication strategy for OAuth2 JWT access tokens (RFC 9068). Extracts the
 * `Authorization: Bearer <token>` header, verifies the JWT signature and
 * `iss`/`aud`/`exp` via {@link JwtAccessTokenService} (no network call per
 * request), and maps the verified claims onto the framework's principal model
 * via {@link claimsToAuthResult} — the same mapping the opaque-introspection
 * strategy uses, so both surface identical `{user}`/`{clientApplication}`
 * principals and feed `@agentback/authorization` scope governance.
 *
 * Register with {@link OAuth2JwtAuthenticationComponent} and protect routes with
 * `@authenticate('oauth2-jwt')`. List alongside the opaque strategy
 * (`@authenticate('oauth2-jwt', 'oauth2')`) to accept either token form.
 */
@injectable({
  tags: {
    [ContextTags.NAME]: 'oauth2-jwt.strategy',
    [AuthenticationBindings.AUTH_STRATEGY]: true,
  },
})
export class OAuth2JwtAuthenticationStrategy implements AuthenticationStrategy {
  name = 'oauth2-jwt';

  constructor(
    @inject(OAuth2JwtBindings.SERVICE) private service: JwtAccessTokenService,
  ) {}

  async authenticate(request: AuthRequest): Promise<AuthenticationResult> {
    const token = extractBearerToken(request);
    const claims = await this.service.verify(token);
    return claimsToAuthResult(claims as PrincipalClaims);
  }
}
