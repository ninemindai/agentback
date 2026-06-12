// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {context as otelContext, SpanKind, trace} from '@opentelemetry/api';
import {MCPBindings, type McpDispatchHook} from '@agentback/mcp';
import type {RestDispatchHook} from '@agentback/rest';
import {securityId, SecurityBindings} from '@agentback/security';
import {getTracer, recordError} from './tracer.js';

/** Binding key {@link installOtel} uses for the REST dispatch hook. */
export const OTEL_REST_DISPATCH_HOOK_KEY = 'otel.dispatchHook.rest';
/** Binding key {@link installOtel} uses for the MCP dispatch hook. */
export const OTEL_MCP_DISPATCH_HOOK_KEY = 'otel.dispatchHook.mcp';

/**
 * REST dispatch hook: wraps every dispatched request in an `INTERNAL` span
 * `rest.dispatch <Controller.method>`. Composes with any other dispatch hook
 * (metering, audit, …) — this replaces the former `OtelRestServer` subclass,
 * which could not stack with other dispatch-wrapping subclasses.
 *
 * Attributes: `code.namespace` (controller), `code.function` (method), and
 * `enduser.id` when authentication resolved a principal — read from the
 * per-request context (`info.ctx`) after the wrapped pipeline ran, since the
 * pipeline binds `SecurityBindings.USER` / `.CLIENT_APPLICATION` into it.
 * Thrown errors (including 401/403 denials and validation failures) are
 * recorded via `span.recordException` with an `ERROR` span status.
 *
 * With no OTel SDK registered every span is a no-op, so binding the hook
 * unconditionally is safe.
 */
export function createOtelRestDispatchHook(): RestDispatchHook {
  return async (info, next) => {
    const span = getTracer().startSpan(
      `rest.dispatch ${info.ctor.name}.${info.methodName}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          'code.namespace': info.ctor.name,
          'code.function': info.methodName,
        },
      },
    );
    return otelContext.with(
      trace.setSpan(otelContext.active(), span),
      async () => {
        try {
          return await next();
        } catch (err) {
          recordError(span, err);
          throw err;
        } finally {
          // The principal is bound into the per-request context *inside* the
          // wrapped pipeline; read it back at end time (optional gets).
          const user = await info.ctx?.get(SecurityBindings.USER, {
            optional: true,
          });
          const client = await info.ctx?.get(
            SecurityBindings.CLIENT_APPLICATION,
            {optional: true},
          );
          const id = user?.[securityId] ?? client?.[securityId];
          if (id !== undefined) span.setAttribute('enduser.id', String(id));
          span.end();
        }
      },
    );
  };
}

/**
 * MCP dispatch hook: wraps every tool call in an `INTERNAL` span
 * `mcp.tool <name>`. Composes with any other dispatch hook and with
 * `dispatchTool` subclasses — this replaces the
 * former `OtelMCPServer` subclass.
 *
 * Attributes: `mcp.tool.name`, and `enduser.id` from the per-request
 * `MCPBindings.REQUEST_AUTH` `clientId` when the transport authenticated the
 * caller. Thrown errors — including input/output validation failures and
 * authorization denials, which the hook sees because it wraps the whole
 * `dispatchTool` body — are recorded via `span.recordException` with an
 * `ERROR` span status.
 *
 * With no OTel SDK registered every span is a no-op, so binding the hook
 * unconditionally is safe.
 */
export function createOtelMcpDispatchHook(): McpDispatchHook {
  return async (info, next) => {
    const span = getTracer().startSpan(`mcp.tool ${info.tool.meta.name}`, {
      kind: SpanKind.INTERNAL,
      attributes: {'mcp.tool.name': info.tool.meta.name},
    });
    return otelContext.with(
      trace.setSpan(otelContext.active(), span),
      async () => {
        try {
          const auth = await info.ctx.get(MCPBindings.REQUEST_AUTH, {
            optional: true,
          });
          if (auth?.clientId) span.setAttribute('enduser.id', auth.clientId);
          return await next();
        } catch (err) {
          recordError(span, err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  };
}
