// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Component} from '@agentback/core';
import type {Binding} from '@agentback/context';
import {createBindingFromClass} from '@agentback/context';
import {OAuth2JwtBindings} from './keys.js';
import {JwtAccessTokenService} from './jwt-access-token.service.js';
import {OAuth2JwtAuthenticationStrategy} from './oauth2-jwt.strategy.js';
import {OAuth2JwtSecuritySpecEnhancer} from './oauth2-jwt.enhancer.js';

/**
 * Component that registers the JWT access-token strategy, the
 * {@link JwtAccessTokenService}, and an OpenAPI spec enhancer that declares
 * `securitySchemes['oauth2-jwtAuth']`.
 *
 * Bind {@link OAuth2JwtBindings.CONFIG} (issuer/audience + `jwksUri`) before
 * adding this component:
 *
 *   app.bind(OAuth2JwtBindings.CONFIG).to({
 *     issuer: process.env.OAUTH2_ISSUER!,
 *     audience: process.env.OAUTH2_AUDIENCE!,
 *     jwksUri: process.env.OAUTH2_JWKS_URI!,
 *   });
 *   app.component(OAuth2JwtAuthenticationComponent);
 *
 * Then protect routes with `@authenticate('oauth2-jwt')`. This component and
 * {@link OAuth2AuthenticationComponent} (opaque introspection) can be used
 * together — list both strategy names on a route to accept either token form.
 */
export class OAuth2JwtAuthenticationComponent implements Component {
  bindings: Binding[] = [
    createBindingFromClass(JwtAccessTokenService, {
      key: OAuth2JwtBindings.SERVICE.key,
    }),
    createBindingFromClass(OAuth2JwtAuthenticationStrategy),
    createBindingFromClass(OAuth2JwtSecuritySpecEnhancer),
  ];
}
