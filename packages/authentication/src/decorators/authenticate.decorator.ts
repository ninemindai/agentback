// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ClassDecoratorFactory,
  MethodDecoratorFactory,
} from '@agentback/metadata';
import {AuthenticationKeys} from '../keys.js';
import type {AuthenticationMetadata} from '../types.js';

/**
 * Decorator that marks a controller class or method as requiring
 * authentication. Applies to both classes (default for all methods) and
 * methods (overrides the class-level setting).
 *
 * @example
 *   @authenticate('jwt')                          // class-level default
 *   class WidgetController { ... }
 *
 *   @get('/widgets')
 *   @authenticate('jwt', {role: 'admin'})         // per-method
 *   async list() { ... }
 *
 *   @get('/public')
 *   @authenticate.skip()                          // explicit opt-out
 *   async ping() { ... }
 */
export function authenticate(
  strategy: string,
  options?: Record<string, unknown>,
): ClassDecorator & MethodDecorator {
  return function authenticateDecorator(
    target: object,
    methodName?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) {
    const meta: AuthenticationMetadata = {strategy, options};
    if (methodName === undefined) {
      // Class-level
      ClassDecoratorFactory.createDecorator<AuthenticationMetadata>(
        AuthenticationKeys.CLASS_METADATA,
        meta,
        {decoratorName: '@authenticate'},
      )(target as Function);
    } else {
      MethodDecoratorFactory.createDecorator<AuthenticationMetadata>(
        AuthenticationKeys.METADATA,
        meta,
        {decoratorName: '@authenticate'},
      )(target, methodName, descriptor!);
    }
  } as ClassDecorator & MethodDecorator;
}

/**
 * Mark a method as explicitly skipping authentication, overriding any
 * class-level `@authenticate` on the controller.
 */
authenticate.skip = function (): MethodDecorator {
  return function skipDecorator(
    target: object,
    methodName: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    MethodDecoratorFactory.createDecorator<AuthenticationMetadata>(
      AuthenticationKeys.METADATA,
      {strategy: '', skip: true},
      {decoratorName: '@authenticate.skip'},
    )(target, methodName, descriptor);
  };
};
