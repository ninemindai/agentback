// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {getControllerSpec} from '@agentback/openapi';

export function lookupSuccessStatus(
  ctor: Function,
  methodName: string,
): number {
  // The status was stored on the operation spec at registration time via
  // resolveControllerSpec. We re-derive it from the controller spec rather
  // than re-walking RouteEndpoint metadata so it stays cache-consistent.
  const spec = getControllerSpec(ctor);
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item as Record<string, unknown>)) {
      if (
        op &&
        typeof op === 'object' &&
        (op as {operationId?: string}).operationId ===
          `${ctor.name}.${methodName}`
      ) {
        const responses = (op as {responses?: Record<string, unknown>})
          .responses;
        if (responses) {
          const codes = Object.keys(responses)
            .map(k => Number(k))
            .filter(n => Number.isFinite(n) && n >= 200 && n < 400);
          if (codes.length) return codes[0]!;
        }
      }
    }
  }
  return 200;
}
