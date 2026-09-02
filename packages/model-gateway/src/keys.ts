// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {CircuitBreaker} from './breaker.js';
import type {LanguageModelLike} from './types.js';

export namespace ModelGatewayBindings {
  /**
   * The app's gateway-wrapped language model. Inject this instead of building
   * a provider model inline, so every call in the app shares one set of
   * policies — and so a test can bind a stub with no network.
   */
  export const MODEL =
    BindingKey.create<LanguageModelLike>('modelGateway.model');
  /**
   * The shared {@link CircuitBreaker}. It must be ONE instance per app: a
   * breaker whose counters reset per request has no memory and therefore no
   * opinion about whether a provider is sick.
   */
  export const BREAKER = BindingKey.create<CircuitBreaker>(
    'modelGateway.breaker',
  );
}
