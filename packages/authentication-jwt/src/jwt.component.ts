// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Component} from '@agentback/core';
import type {Binding} from '@agentback/context';
import {createBindingFromClass} from '@agentback/context';
import {JWTBindings} from './keys.js';
import {JWTService} from './jwt.service.js';
import {JWTAuthenticationStrategy} from './jwt.strategy.js';
import {JWTSecuritySpecEnhancer} from './jwt.enhancer.js';

/**
 * Component that registers the JWT auth strategy, the JWTService, and an
 * OpenAPI spec enhancer that declares `securitySchemes.jwtAuth`.
 *
 * Bind `JWTBindings.SECRET` and `JWTBindings.EXPIRES_IN` before adding
 * this component:
 *
 *   app.bind(JWTBindings.SECRET).to(process.env.JWT_SECRET!);
 *   app.bind(JWTBindings.EXPIRES_IN).to('1h');
 *   app.component(JWTAuthenticationComponent);
 */
export class JWTAuthenticationComponent implements Component {
  bindings: Binding[] = [
    createBindingFromClass(JWTService, {key: JWTBindings.SERVICE.key}),
    createBindingFromClass(JWTAuthenticationStrategy),
    createBindingFromClass(JWTSecuritySpecEnhancer),
  ];
}
