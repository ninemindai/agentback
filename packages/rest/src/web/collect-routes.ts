// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {CoreTags} from '@agentback/core';
import {getControllerSpec, lookupRouteSchemas} from '@agentback/openapi';
import {lookupSuccessStatus} from '../route-meta.js';
import type {RouteRecord} from './router.js';
import type {RouteValue} from './route-value.js';

/**
 * Build the core Router's route records from the controllers bound in `context`
 * — the same discovery `RestServer.controller()` does for Express, emitting the
 * OpenAPI `{name}` path template the core Router matches natively. `basePath`
 * mirrors the RestServer config prefix.
 */
export function collectRoutes(
  context: Context,
  basePath = '',
): RouteRecord<RouteValue>[] {
  const records: RouteRecord<RouteValue>[] = [];
  for (const binding of context.findByTag(CoreTags.CONTROLLER)) {
    const ctor = binding.valueConstructor;
    if (typeof ctor !== 'function') continue;
    const spec = getControllerSpec(ctor);
    const prefix = basePath + (spec.basePath ?? '');
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [verb, operation] of Object.entries(
        item as Record<string, unknown>,
      )) {
        if (!operation || typeof operation !== 'object') continue;
        const methodName = (operation as {operationId: string}).operationId
          .split('.')
          .pop()!;
        const schemas = lookupRouteSchemas(ctor.prototype, methodName) ?? {};
        records.push({
          method: verb.toUpperCase(),
          template: prefix + path,
          value: {
            ctor,
            methodName,
            schemas,
            successStatus: lookupSuccessStatus(ctor, methodName),
          },
        });
      }
    }
  }
  return records;
}
