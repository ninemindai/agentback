// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {injectable, ContextTags} from '@agentback/core';
import type {OpenApiSpec} from '../types.js';
import {OASEnhancer, OAS_ENHANCER_EXTENSION_POINT} from './types.js';

/**
 * Populates `info.title`, `info.version`, `info.description` from a
 * configured source (e.g. the host application's package.json). Mirrors
 * @loopback/rest's InfoSpecEnhancer.
 */
@injectable({
  tags: {
    [ContextTags.NAME]: 'info.enhancer',
    extensionFor: OAS_ENHANCER_EXTENSION_POINT,
  },
})
export class InfoEnhancer implements OASEnhancer {
  name = 'info';
  constructor(private info: Partial<OpenApiSpec['info']> = {}) {}

  modifySpec(spec: OpenApiSpec): OpenApiSpec {
    return {
      ...spec,
      info: {...spec.info, ...this.info},
    };
  }
}
