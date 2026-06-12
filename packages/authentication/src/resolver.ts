// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {MetadataInspector} from '@agentback/metadata';
import {securityId, type UserProfile} from '@agentback/security';
import {AuthenticationBindings, AuthenticationKeys} from './keys.js';
import type {
  AuthenticationMetadata,
  AuthenticationResult,
  AuthenticationStrategy,
} from './types.js';

/**
 * Normalize a strategy's return value into an {@link AuthenticationResult}.
 * A bare `UserProfile` (a principal carrying `securityId`) becomes `{user}`;
 * an `AuthenticationResult` is returned as-is; `undefined` becomes `{}`.
 */
export function normalizeAuthResult(
  raw: UserProfile | AuthenticationResult | undefined,
): AuthenticationResult {
  if (!raw) return {};
  if (securityId in raw) return {user: raw as UserProfile};
  return raw as AuthenticationResult;
}

/**
 * Look up the effective AuthenticationMetadata for a controller method.
 * Method-level metadata wins over class-level. Returns undefined if the
 * route has no authentication requirement.
 */
export function getAuthenticationMetadata(
  controllerCtor: Function,
  methodName: string | symbol,
): AuthenticationMetadata | undefined {
  const methodMeta =
    MetadataInspector.getMethodMetadata<AuthenticationMetadata>(
      AuthenticationKeys.METADATA,
      controllerCtor.prototype,
      String(methodName),
    );
  if (methodMeta) return methodMeta;
  return MetadataInspector.getClassMetadata<AuthenticationMetadata>(
    AuthenticationKeys.CLASS_METADATA,
    controllerCtor,
  );
}

/**
 * Resolve a strategy by name from the context. Strategies are expected to
 * be bound with the `authentication.strategy` tag and a `name` matching
 * their `AuthenticationStrategy.name` property.
 */
export async function resolveStrategy(
  context: Context,
  name: string,
): Promise<AuthenticationStrategy | undefined> {
  const bindings = context.findByTag(AuthenticationBindings.AUTH_STRATEGY);
  for (const b of bindings) {
    const strategy = await context.get<AuthenticationStrategy>(b.key);
    if (strategy.name === name) return strategy;
  }
  return undefined;
}
