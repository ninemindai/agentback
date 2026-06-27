// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Application} from '@agentback/core';
import {MCP_DISPATCH_HOOK_TAG} from '@agentback/mcp';
import {MeteringBindings} from '@agentback/metering';
import {
  REST_DISPATCH_HOOK_TAG,
  type RestApplication,
  type RestServer,
} from '@agentback/rest';
import {
  createOtelMcpDispatchHook,
  createOtelRestDispatchHook,
  OTEL_MCP_DISPATCH_HOOK_KEY,
  OTEL_REST_DISPATCH_HOOK_KEY,
} from './dispatch-hooks.js';
import {getActiveTraceId} from './tracer.js';
import {mountOtel, type OtelOptions} from './rest-middleware.js';

/**
 * Install OpenTelemetry tracing on an application — one call does everything:
 *
 * 1. Binds the REST dispatch hook (`rest.dispatch <Controller.method>`
 *    `INTERNAL` spans) under {@link REST_DISPATCH_HOOK_TAG}.
 * 2. Binds the MCP dispatch hook (`mcp.tool <name>` `INTERNAL` spans) under
 *    {@link MCP_DISPATCH_HOOK_TAG}.
 * 3. On a `RestApplication`, mounts the per-request `SERVER`-span Express
 *    middleware (W3C `traceparent` aware) on the REST server.
 *
 * Hooks compose with other dispatch hooks and with `dispatch`/`dispatchTool`
 * subclasses — a subclass override wraps the hook chain. Call BEFORE `app.start()`: the servers cache the resolved
 * hook list on the first dispatched request.
 *
 * Works on MCP-only applications too — the REST middleware step is skipped
 * when the app has no REST server.
 */
export async function installOtel(
  app: Application,
  options: OtelOptions = {},
): Promise<void> {
  app
    .bind(OTEL_REST_DISPATCH_HOOK_KEY)
    .to(createOtelRestDispatchHook())
    .tag(REST_DISPATCH_HOOK_TAG);
  app
    .bind(OTEL_MCP_DISPATCH_HOOK_KEY)
    .to(createOtelMcpDispatchHook())
    .tag(MCP_DISPATCH_HOOK_TAG);

  // Billing/tracing correlation: when metering is installed, every
  // UsageEvent gets the active trace id stamped onto it.
  app.bind(MeteringBindings.TRACE_ID_PROVIDER.key).to(getActiveTraceId);

  // REST SERVER-span middleware — only when the app exposes a REST server.
  const maybeRest = app as Partial<Pick<RestApplication, 'restServer'>>;
  if (maybeRest.restServer) {
    const server: RestServer = await maybeRest.restServer;
    mountOtel(server, options);
  }
}
