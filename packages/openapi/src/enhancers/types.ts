// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {OpenApiSpec} from '../types.js';

/**
 * Extension point: contributors implement `modifySpec` to post-process the
 * assembled OpenAPI document. Mirrors @loopback/openapi-v3's OASEnhancer
 * surface trimmed to what we actually need.
 */
export interface OASEnhancer {
  name: string;
  modifySpec(spec: OpenApiSpec): OpenApiSpec | Promise<OpenApiSpec>;
}

export const OAS_ENHANCER_EXTENSION_POINT = 'openapi.spec.enhancer';
