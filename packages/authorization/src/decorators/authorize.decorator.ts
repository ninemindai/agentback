// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ClassDecoratorFactory,
  MethodDecoratorFactory,
} from '@agentback/metadata';
import {AuthorizationKeys} from '../keys.js';
import type {AuthorizationMetadata} from '../types.js';

/**
 * Method or class decorator declaring authorization requirements.
 *
 * @example
 *   @authorize({allowedRoles: ['admin']})
 *   @get('/widgets')
 *   list() {...}
 *
 *   @authorize({scopes: ['widgets:write']})
 *   @post('/widgets')
 *   create() {...}
 */
export function authorize(
  meta: AuthorizationMetadata,
): ClassDecorator & MethodDecorator {
  return function authorizeDecorator(
    target: object,
    methodName?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) {
    if (methodName === undefined) {
      ClassDecoratorFactory.createDecorator<AuthorizationMetadata>(
        AuthorizationKeys.CLASS_METADATA,
        meta,
        {decoratorName: '@authorize'},
      )(target as Function);
    } else {
      MethodDecoratorFactory.createDecorator<AuthorizationMetadata>(
        AuthorizationKeys.METADATA,
        meta,
        {decoratorName: '@authorize'},
      )(target, methodName, descriptor!);
    }
  } as ClassDecorator & MethodDecorator;
}

/** Convenience: bypass authorization (overrides class-level @authorize). */
authorize.skip = function (): MethodDecorator {
  return function skipDecorator(
    target: object,
    methodName: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    MethodDecoratorFactory.createDecorator<AuthorizationMetadata>(
      AuthorizationKeys.METADATA,
      {skip: true},
      {decoratorName: '@authorize.skip'},
    )(target, methodName, descriptor);
  };
};

/** Shortcut: require any of the given roles. */
authorize.allowedRoles = (...roles: string[]): MethodDecorator =>
  authorize({allowedRoles: roles}) as MethodDecorator;
