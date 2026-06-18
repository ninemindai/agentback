// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MetadataAccessor} from '@agentback/metadata';
import type {ControllerSpec} from './controller-spec.js';
import type {RouteOptions} from './decorators/operation.decorator.js';

/**
 * Metadata keys used by the openapi decorators. Trimmed to what the
 * method-level-schema design needs — per-parameter `@param`,
 * `@requestBody`, and `@response` are gone; schemas live on the verb
 * decorator's `RouteOptions` and ride along on the route metadata.
 */
export namespace OAI3Keys {
  export const CONTROLLER_SPEC_KEY = MetadataAccessor.create<
    ControllerSpec,
    ClassDecorator
  >('openapi-v3:controller-spec');

  export const CLASS_KEY = MetadataAccessor.create<
    ControllerSpec,
    ClassDecorator
  >('openapi-v3:class');

  export const METHODS_KEY = MetadataAccessor.create<
    RestEndpoint,
    MethodDecorator
  >('openapi-v3:methods');
}

export interface RestEndpoint {
  verb: string;
  path: string;
  /** Route options as declared on the verb decorator. */
  options: RouteOptions;
  target: Object;
  methodName: string | symbol;
}
