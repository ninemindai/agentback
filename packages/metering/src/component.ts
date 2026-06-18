// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Component} from '@agentback/core';
import {
  Binding,
  BindingScope,
  type ResolutionContext,
} from '@agentback/context';
import {MCP_DISPATCH_HOOK_TAG} from '@agentback/mcp';
import {REST_DISPATCH_HOOK_TAG} from '@agentback/rest';
import {
  createMeteringMcpHook,
  createMeteringRestHook,
  METERING_MCP_HOOK_KEY,
  METERING_REST_HOOK_KEY,
} from './dispatch-hooks.js';
import {MeteringBindings} from './keys.js';
import {InMemoryUsageSink} from './in-memory-sink.js';
import {InMemoryQuotaService} from './quota.js';
import {Meter} from './meter.js';

/**
 * Registers the full metering stack: an in-memory {@link UsageSink}, an
 * in-memory {@link QuotaService}, a {@link Meter} bound to the sink, and the
 * REST/MCP dispatch hooks that emit one usage event per request / tool call.
 * `app.component(MeteringComponent)` is all it takes — the hooks compose
 * with tracing and other dispatch hooks (no server subclass needed).
 *
 * Override any binding to swap in a durable sink or a real quota policy:
 *
 *   app.bind(MeteringBindings.SINK).toClass(RedisUsageSink);
 *
 * The {@link Meter} resolves the sink at construction, so rebind the sink
 * before the meter is first requested (component order handles this).
 */
export class MeteringComponent implements Component {
  bindings: Binding[] = [
    // Singletons: the sink and quota hold state that the Meter (writer) and
    // consumers (readers) must share — a transient scope would hand each
    // resolution a fresh, empty instance.
    Binding.bind(MeteringBindings.SINK)
      .toClass(InMemoryUsageSink)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(MeteringBindings.QUOTA)
      .toClass(InMemoryQuotaService)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(MeteringBindings.METER)
      .toDynamicValue(
        async (rctx: ResolutionContext) =>
          new Meter(await rctx.context.get(MeteringBindings.SINK), {
            traceIdProvider: await rctx.context.get(
              MeteringBindings.TRACE_ID_PROVIDER,
              {optional: true},
            ),
          }),
      )
      .inScope(BindingScope.SINGLETON),
    // Dispatch hooks: transparent passthroughs until a Meter resolves, so
    // they are safe to bind unconditionally with the component.
    Binding.bind(METERING_REST_HOOK_KEY)
      .toDynamicValue((rctx: ResolutionContext) =>
        createMeteringRestHook(rctx.context),
      )
      .inScope(BindingScope.SINGLETON)
      .tag(REST_DISPATCH_HOOK_TAG),
    Binding.bind(METERING_MCP_HOOK_KEY)
      .toDynamicValue((rctx: ResolutionContext) =>
        createMeteringMcpHook(rctx.context),
      )
      .inScope(BindingScope.SINGLETON)
      .tag(MCP_DISPATCH_HOOK_TAG),
  ];
}
