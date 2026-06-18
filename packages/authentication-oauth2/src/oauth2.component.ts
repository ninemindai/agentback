// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Component} from '@agentback/core';
import type {Binding} from '@agentback/context';
import {createBindingFromClass} from '@agentback/context';
import {OAuth2Bindings} from './keys.js';
import {OAuth2IntrospectionService} from './introspection.service.js';
import {OAuth2AuthenticationStrategy} from './oauth2.strategy.js';
import {OAuth2SecuritySpecEnhancer} from './oauth2.enhancer.js';

/**
 * Component that registers the OAuth2 introspection strategy, the
 * {@link OAuth2IntrospectionService}, and an OpenAPI spec enhancer that
 * declares `securitySchemes.oauth2Auth`.
 *
 * Bind {@link OAuth2Bindings.CONFIG} (the introspection endpoint + the
 * resource server's own client credentials) before adding this component:
 *
 *   app.bind(OAuth2Bindings.CONFIG).to({
 *     introspectionUrl: process.env.OAUTH2_INTROSPECTION_URL!,
 *     clientId: process.env.OAUTH2_CLIENT_ID!,
 *     clientSecret: process.env.OAUTH2_CLIENT_SECRET!,
 *   });
 *   app.component(OAuth2AuthenticationComponent);
 *
 * Then protect routes with `@authenticate('oauth2')`.
 */
export class OAuth2AuthenticationComponent implements Component {
  bindings: Binding[] = [
    createBindingFromClass(OAuth2IntrospectionService, {
      key: OAuth2Bindings.SERVICE.key,
    }),
    createBindingFromClass(OAuth2AuthenticationStrategy),
    createBindingFromClass(OAuth2SecuritySpecEnhancer),
  ];
}
