// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MethodDecoratorFactory} from '@agentback/metadata';
import {MCPKeys, PromptMetadata} from '../keys.js';

export interface PromptOptions {
  description?: string;
}

/**
 * Declare a method as an MCP prompt. The method must return either a
 * string or a structured `GetPromptResult` per the MCP spec.
 */
export function prompt(
  name: string,
  options: PromptOptions = {},
): MethodDecorator {
  return function promptDecorator(
    target: Object,
    methodName: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const meta: PromptMetadata = {
      name,
      description: options.description,
      methodName,
    };
    MethodDecoratorFactory.createDecorator<PromptMetadata>(
      MCPKeys.PROMPT,
      meta,
      {decoratorName: '@prompt'},
    )(target, methodName, descriptor);
  };
}
