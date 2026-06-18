// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MethodDecoratorFactory} from '@agentback/metadata';
import {MCPKeys, ResourceMetadata} from '../keys.js';

export interface ResourceOptions {
  description?: string;
  mimeType?: string;
}

/**
 * Declare a method as an MCP resource. The `uri` may be a literal URI or a
 * URI Template (RFC 6570) using `{arg}` placeholders that map to `@arg`
 * declarations on the same method.
 */
export function resource(
  uri: string,
  options: ResourceOptions & {name?: string} = {},
): MethodDecorator {
  return function resourceDecorator(
    target: Object,
    methodName: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const meta: ResourceMetadata = {
      name: options.name ?? String(methodName),
      uri,
      description: options.description,
      mimeType: options.mimeType,
      methodName,
    };
    MethodDecoratorFactory.createDecorator<ResourceMetadata>(
      MCPKeys.RESOURCE,
      meta,
      {decoratorName: '@resource'},
    )(target, methodName, descriptor);
  };
}
