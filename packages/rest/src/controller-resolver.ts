// Copyright ninemind.ai 2026. All Rights Reserved.
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
  for (const binding of context.findByTag(CoreTags.CONTROLLER)) {
    if ((binding.valueConstructor as unknown) === ctor) {
      return context.get<T>(binding.key);
    }
  }
  if (context.contains(`controllers.${ctor.name}`)) {
    return context.get<T>(`controllers.${ctor.name}`);
  }
  throw new Error(
    `Controller ${ctor.name} is not bound. Use app.controller(${ctor.name}).`,
  );
}
