// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {MCPBindings, type McpDispatchHook} from '@agentback/mcp';
import type {RestDispatchHook} from '@agentback/rest';
import {MeteringBindings} from './keys.js';
import {getPrice} from './price.js';
import {
  ANONYMOUS,
  principalFromAuthInfo,
  principalFromContext,
} from './principal.js';

/** Binding keys for the hooks {@link MeteringComponent} registers. */
export const METERING_REST_HOOK_KEY = 'metering.hooks.rest';
export const METERING_MCP_HOOK_KEY = 'metering.hooks.mcp';

/**
 * REST dispatch hook: emits one usage event per dispatched request.
 * Replaces the former `MeteredRestServer` subclass — as a hook it composes
 * with tracing, audit, and any other dispatch hooks.
 *
 * The principal is read from the per-request context *after* the wrapped
 * pipeline ran (auth binds `SecurityBindings.USER` inside it), via the
 * descriptor thunk `Meter.observe` resolves at record time. When no `Meter`
 * is bound the hook is a transparent passthrough, so binding it
 * unconditionally is safe.
 */
export function createMeteringRestHook(appCtx: Context): RestDispatchHook {
  return async (info, next) => {
    const meter = await appCtx.get(MeteringBindings.METER, {optional: true});
    if (!meter) return next();
    const priceSpec = getPrice(info.ctor.prototype, info.methodName);
    return meter.observe(
      () => ({
        surface: 'rest' as const,
        operation: `${info.ctor.name}.${info.methodName}`,
        principal: info.ctx ? principalFromContext(info.ctx) : ANONYMOUS,
        ...(priceSpec
          ? {
              units: priceSpec.units ?? 1,
              cost: {amount: priceSpec.amount, currency: priceSpec.currency},
            }
          : {}),
      }),
      next,
    );
  };
}

/**
 * MCP dispatch hook: emits one usage event per tool call. Replaces the
 * former `MeteredMCPServer` subclass. The principal comes from the
 * per-request `MCPBindings.REQUEST_AUTH` (deposited by the mcp-http
 * framework-auth guard / OAuth verifier).
 */
export function createMeteringMcpHook(appCtx: Context): McpDispatchHook {
  return async (info, next) => {
    const meter = await appCtx.get(MeteringBindings.METER, {optional: true});
    if (!meter) return next();
    const auth = await info.ctx.get(MCPBindings.REQUEST_AUTH, {
      optional: true,
    });
    const priceSpec = getPrice(
      info.tool.ctor.prototype,
      info.tool.meta.methodName,
    );
    return meter.observe(
      {
        surface: 'mcp' as const,
        operation: info.tool.meta.name,
        principal: principalFromAuthInfo(auth),
        ...(priceSpec
          ? {
              units: priceSpec.units ?? 1,
              cost: {amount: priceSpec.amount, currency: priceSpec.currency},
            }
          : {}),
      },
      next,
    );
  };
}
