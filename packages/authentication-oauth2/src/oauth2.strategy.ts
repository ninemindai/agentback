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
import {OAuth2Bindings} from './keys.js';
import type {OAuth2IntrospectionService} from './introspection.service.js';
import {claimsToAuthResult} from './principal-mapping.js';
import {extractBearerToken} from './bearer.js';

/**
 * Authentication strategy for opaque OAuth2 access tokens. Extracts the
 * `Authorization: Bearer <token>` header, validates the token via
 * {@link OAuth2IntrospectionService} (RFC 7662), and maps the introspection
 * response onto the framework's principal model — `sub` → `{user}`,
 * `client_id` → `{clientApplication}` — via {@link claimsToAuthResult}, so the
 * granted scopes flow into `@agentback/authorization` governance unchanged.
 *
 * Register with {@link OAuth2AuthenticationComponent} and protect routes with
 * `@authenticate('oauth2')`.
 */
@injectable({
  tags: {
    [ContextTags.NAME]: 'oauth2.strategy',
    [AuthenticationBindings.AUTH_STRATEGY]: true,
  },
})
export class OAuth2AuthenticationStrategy implements AuthenticationStrategy {
  name = 'oauth2';

  constructor(
    @inject(OAuth2Bindings.SERVICE) private service: OAuth2IntrospectionService,
  ) {}

  async authenticate(request: AuthRequest): Promise<AuthenticationResult> {
    const token = extractBearerToken(request);
    const claims = await this.service.introspect(token);
    return claimsToAuthResult(claims);
  }
}
