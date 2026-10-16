// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {Meter} from './meter.js';
import type {ActorKind, QuotaService, UsageSink} from './types.js';

export namespace MeteringBindings {
  /** The {@link Meter} the metered servers resolve to emit usage events. */
  export const METER = BindingKey.create<Meter>('metering.meter');
  /** The durable {@link UsageSink}. Defaults to in-memory. */
  export const SINK = BindingKey.create<UsageSink>('metering.sink');
  /** The {@link QuotaService} for `metered?` enforcement. */
  export const QUOTA = BindingKey.create<QuotaService>('metering.quota');
  /**
   * Optional provider of the active trace id, stamped onto every
   * {@link UsageEvent} — bind it to correlate billing with tracing
   * (`@agentback/extension-otel`'s `installOtel` binds
   * `getActiveTraceId` here automatically).
   */
  export const TRACE_ID_PROVIDER = BindingKey.create<() => string | undefined>(
    'metering.traceIdProvider',
  );
  /**
   * The current agent turn's id, bound into a turn-scoped context by
   * `@agentback/agents`. The MCP dispatch hook reads it through the context
   * chain at record time and stamps it as {@link UsageEvent.turnId} (and, for
   * one release, as `meta.correlationId`), so one turn's `'agent'` event and
   * its N `'mcp'` tool events share a join key.
   */
  export const CORRELATION_ID = BindingKey.create<string>(
    'metering.correlationId',
  );
  /**
   * Who is calling, bound only where the framework observes it:
   * `@agentback/agents` binds `'agent'` into each turn's context, so the MCP
   * dispatch hook stamps {@link UsageEvent.actorKind} on that turn's host-tool
   * calls. Do not bind it for a caller you cannot observe; an external MCP or
   * REST caller gets no `actorKind`.
   */
  export const ACTOR_KIND = BindingKey.create<ActorKind>('metering.actorKind');
  /**
   * Optional run id owned by the app (a job run, a workflow run, a session).
   * When bound anywhere in the context chain of a call, the REST and MCP
   * dispatch hooks and `@agentback/agents` turns stamp it as
   * {@link UsageEvent.runId}. The framework never binds it.
   */
  export const RUN_ID = BindingKey.create<string>('metering.runId');
}
