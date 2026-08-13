// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/rest
// This file is licensed under the MIT License.

import type {Context} from '@agentback/context';
import {CoreTags} from '@agentback/core';

/**
 * Shared controller-resolution logic used by both {@link RestServer} (Express
 * path) and {@link RestHandler} (Web/fetch path). Looks up the binding tagged
 * `controller` whose `valueConstructor === ctor`, falling back to
 * `controllers.${ctor.name}`, then throws if neither is found.
 */
export async function resolveControllerInstance<T>(
  context: Context,
  ctor: Function,
): Promise<T> {
  const key = findControllerBindingKey(context, ctor);
  if (key !== undefined) return context.get<T>(key);
  throw new Error(
    `Controller ${ctor.name} is not bound. Use app.controller(${ctor.name}).`,
  );
}

/**
 * The binding key {@link resolveControllerInstance} would resolve `ctor`
 * through, or `undefined` when the controller is not (or no longer) bound.
 * The dispatch paths use this as a per-request liveness gate: routes are
 * baked into the hosts at start(), so an unbound controller's routes answer
 * 404 instead of a resolver 500 — which is what lets an install helper
 * retract a controller with `unbind()` (revertible-installs.md).
 */
export function findControllerBindingKey(
  context: Context,
  ctor: Function,
): string | undefined {
  for (const binding of context.findByTag(CoreTags.CONTROLLER)) {
    if ((binding.valueConstructor as unknown) === ctor) {
      return binding.key;
    }
  }
  if (context.contains(`controllers.${ctor.name}`)) {
    return `controllers.${ctor.name}`;
  }
  return undefined;
}
