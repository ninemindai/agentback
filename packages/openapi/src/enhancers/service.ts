// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {extensionPoint, extensions, Getter} from '@agentback/core';
import type {OpenApiSpec} from '../types.js';
import {OASEnhancer, OAS_ENHANCER_EXTENSION_POINT} from './types.js';

/**
 * Sequentially apply all registered OASEnhancers to the spec. The order is
 * the binding order in the IoC container.
 */
@extensionPoint(OAS_ENHANCER_EXTENSION_POINT)
export class OASEnhancerService {
  constructor(
    @extensions()
    private readonly getEnhancers: Getter<OASEnhancer[]>,
  ) {}

  async applyAllEnhancers(spec: OpenApiSpec): Promise<OpenApiSpec> {
    let result = spec;
    const enhancers = await this.getEnhancers();
    for (const e of enhancers) {
      result = await e.modifySpec(result);
    }
    return result;
  }
}
