// Copyright NineMind, Inc. 2026. All Rights Reserved.
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
    return meter.observe(() => {
      // The app's run id, if it bound one anywhere up the chain. A REST
      // caller gets no actorKind: the framework cannot tell a person from
      // an agent here.
      const runId = info.ctx?.getSync(MeteringBindings.RUN_ID, {
        optional: true,
      });
      return {
        surface: 'rest' as const,
        operation: `${info.ctor.name}.${info.methodName}`,
        principal: info.ctx ? principalFromContext(info.ctx) : ANONYMOUS,
        ...(runId ? {runId} : {}),
        ...(priceSpec
          ? {
              units: priceSpec.units ?? 1,
              cost: {amount: priceSpec.amount, currency: priceSpec.currency},
            }
          : {}),
      };
    }, next);
  };
}

/**
 * MCP dispatch hook: emits one usage event per tool call. Replaces the
 * former `MeteredMCPServer` subclass. The principal comes from the
 * per-request `MCPBindings.REQUEST_AUTH` (deposited by the mcp-http
 * framework-auth guard / OAuth verifier); when no transport auth is bound
 * (an in-process `callTool` — e.g. an `@agentback/agents` host-tool call),
 * it falls back to the principal the pipeline bound into the request
 * context, resolved via a record-time thunk exactly like the REST hook.
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
      () => {
        // Turn correlation: an agent turn binds its id and its actor kind
        // into the turn-scoped parent context; the chain walk finds them from
        // the request child. An external MCP request has no turn context in
        // its chain, so it gets neither: the framework cannot observe whether
        // a person or an agent is on the other end.
        const turnId = info.ctx.getSync(MeteringBindings.CORRELATION_ID, {
          optional: true,
        });
        const actorKind = info.ctx.getSync(MeteringBindings.ACTOR_KIND, {
          optional: true,
        });
        const runId = info.ctx.getSync(MeteringBindings.RUN_ID, {
          optional: true,
        });
        return {
          surface: 'mcp' as const,
          operation: info.tool.meta.name,
          // Transport auth wins; otherwise read the request context after the
          // wrapped pipeline ran (bindRequestPrincipals binds USER inside it,
          // including an explicit callTool {principal}).
          principal: auth
            ? principalFromAuthInfo(auth)
            : principalFromContext(info.ctx),
          ...(turnId ? {turnId} : {}),
          ...(actorKind ? {actorKind} : {}),
          ...(runId ? {runId} : {}),
          // Deprecated: the same id as `turnId`, kept for one release.
          ...(turnId ? {meta: {correlationId: turnId}} : {}),
          ...(priceSpec
            ? {
                units: priceSpec.units ?? 1,
                cost: {amount: priceSpec.amount, currency: priceSpec.currency},
              }
            : {}),
        };
        // A round that only asked the user something (a `confirm:` prompt or an
        // elicitation) produced no result; the call is billed once, on the
        // final round.
      },
      next,
      {skip: () => info.inputRequired === true},
    );
  };
}
