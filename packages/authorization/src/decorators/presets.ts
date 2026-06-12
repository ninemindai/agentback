// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AUTHORIZATION_CURRENT_TENANT} from '../keys.js';
import {
  AUTHENTICATED,
  AuthorizationDecision,
  EVERYONE,
  type Authorizer,
} from '../types.js';
import {authorize} from './authorize.decorator.js';

/**
 * Apply several class/method decorators as one. Useful for bundling
 * authentication and authorization on a single route, e.g.
 *
 *   const adminApi = composeAuthDecorators(authenticate('jwt'), roleAuth('admin'));
 *   class Ctrl { @adminApi @get('/x') x() {} }
 *
 * Each decorator is applied in order. Works for both class and method targets.
 */
export function composeAuthDecorators(
  ...decorators: Array<ClassDecorator | MethodDecorator>
): ClassDecorator & MethodDecorator {
  return function composed(
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) {
    for (const d of decorators) {
      if (propertyKey === undefined) {
        (d as ClassDecorator)(target as Function);
      } else {
        (d as MethodDecorator)(target, propertyKey, descriptor!);
      }
    }
  } as ClassDecorator & MethodDecorator;
}

/** Require any of the given role(s), optionally also requiring scopes. */
export function roleAuth(
  allowedRoles: string | string[],
  ...scopes: string[]
): ClassDecorator & MethodDecorator {
  return authorize({
    allowedRoles: Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles],
    scopes: scopes.length ? scopes : undefined,
  });
}

/** Require an authenticated user (any principal), optionally with scopes. */
export function authRequired(
  ...scopes: string[]
): ClassDecorator & MethodDecorator {
  return roleAuth(AUTHENTICATED, ...scopes);
}

/** Allow everyone — an explicit public route (overrides a class-level rule). */
export function publicRoute(): ClassDecorator & MethodDecorator {
  return authorize({allowedRoles: [EVERYONE]});
}

/** Require all of the given OAuth-style scopes. */
export function requireScopes(
  scope: string,
  ...extra: string[]
): ClassDecorator & MethodDecorator {
  return authorize({scopes: [scope, ...extra]});
}

/** Bypass the scope/authorization check for this route. */
requireScopes.skip = (): MethodDecorator => authorize.skip();

/**
 * Restrict a route to the listed tenant id(s). Reads the current tenant from
 * the request context under {@link AUTHORIZATION_CURRENT_TENANT}; denies when
 * no tenant is bound or it is not in the list (fail-closed).
 */
export function tenantOnly(
  ...tenantIds: string[]
): ClassDecorator & MethodDecorator {
  const voter: Authorizer = async ctx => {
    const ic = ctx.invocationContext;
    if (!ic) return AuthorizationDecision.DENY;
    const tenant = await ic.get(AUTHORIZATION_CURRENT_TENANT, {optional: true});
    const id = typeof tenant === 'string' ? tenant : tenant?.id;
    return id != null && tenantIds.includes(id)
      ? AuthorizationDecision.ALLOW
      : AuthorizationDecision.DENY;
  };
  return authorize({voters: [voter]});
}
