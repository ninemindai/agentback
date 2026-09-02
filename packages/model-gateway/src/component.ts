// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding, BindingScope} from '@agentback/context';
import type {Component} from '@agentback/core';
import {CircuitBreaker, type BreakerOptions} from './breaker.js';
import {ModelGatewayBindings} from './keys.js';

/**
 * Binds the shared {@link CircuitBreaker}.
 *
 * Only the breaker: it is the one piece of gateway state that MUST be a
 * singleton (see {@link ModelGatewayBindings.BREAKER}). The wrapped model
 * itself is not bound here because the app owns which provider it talks to —
 * bind it yourself under {@link ModelGatewayBindings.MODEL}:
 *
 * ```ts
 * app.component(ModelGatewayComponent);
 * app.bind(ModelGatewayBindings.MODEL).to(
 *   await wrapModel(anthropic('claude-sonnet-5'), {
 *     accounting: {meter: await app.get(MeteringBindings.METER)},
 *     breaker: await app.get(ModelGatewayBindings.BREAKER),
 *   }),
 * );
 * ```
 */
export class ModelGatewayComponent implements Component {
  readonly bindings: Binding[];

  constructor(options: BreakerOptions = {}) {
    this.bindings = [
      Binding.bind(ModelGatewayBindings.BREAKER)
        .to(new CircuitBreaker(options))
        .inScope(BindingScope.SINGLETON),
    ];
  }
}
