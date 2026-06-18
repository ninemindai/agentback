// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ClassDecoratorFactory} from '@agentback/metadata';
import {OAI3Keys} from '../keys.js';
import type {ControllerSpec} from '../controller-spec.js';

/**
 * Class-level decorator declaring a controller. Sets default base path and
 * spec-level metadata that the assembler will fold into the final OpenAPI doc.
 */
export function api(spec: ControllerSpec): ClassDecorator {
  return ClassDecoratorFactory.createDecorator(OAI3Keys.CLASS_KEY, spec, {
    decoratorName: '@api',
  });
}
