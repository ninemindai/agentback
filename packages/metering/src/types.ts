// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/** Outcome of a metered call. Only `ok` is billable by default. */
export type UsageStatus =
  'ok' | 'error' | 'denied' | 'rate_limited' | 'payment_required';

/** The billable account a call is attributed to. */
export interface PrincipalRef {
  kind: 'user' | 'client' | 'anonymous';
  id: string;
}

/**
 * Who made a call, when the framework can observe it. Only `'agent'` exists:
 * an `@agentback/agents` turn and the host-tool calls it makes are the one
 * place the framework knows the caller is an agent. A REST or external MCP
 * caller may be a person or an agent, and the framework cannot tell which, so
 * those events carry no `actorKind` rather than a guess.
 */
export type ActorKind = 'agent';

/** What was called — a REST route, an MCP tool, or an agent turn. */
export interface UsageDescriptor {
  surface: 'rest' | 'mcp' | 'agent';
  /** Route id (`Controller.method`), tool name, or agent id. */
  operation: string;
  principal: PrincipalRef;
  /** Billable units; defaults to 1 (one call). */
  units?: number;
  /** Free-form context: request id, session id, scopes, etc. */
  meta?: Record<string, unknown>;
  /**
   * Declared price for the call (the `@price` decorator stamps it via the
   * dispatch hooks). Per call, not per unit; billing layers may still
   * multiply by `units` for multi-unit operations.
   */
  cost?: {amount: string; currency: string};
  /**
   * Explicit trace id for this event. Usually omitted — the Meter stamps it
   * from the bound `TRACE_ID_PROVIDER` when one exists.
   */
  traceId?: string;
  /**
   * The agent turn this event belongs to. An `@agentback/agents` turn stamps
   * it on its own `'agent'` event, on each host-tool `'mcp'` event, and on the
   * gateway's token events, so a sink can group a turn. Absent outside a turn.
   */
  turnId?: string;
  /**
   * Who made the call, set only where the framework observes it (see
   * {@link ActorKind}). Absent means unknown, not "a person".
   */
  actorKind?: ActorKind;
  /**
   * The app's run id, read from `MeteringBindings.RUN_ID` through the context
   * chain. The framework never invents one; it is absent unless the app binds
   * it.
   */
  runId?: string;
}

/**
 * One durable record of a call. The `cost` is left for an external billing
 * layer to price; the substrate only records `units`.
 */
export interface UsageEvent extends UsageDescriptor {
  id: string;
  at: string; // ISO timestamp
  status: UsageStatus;
  latencyMs: number;
  units: number;
  /**
   * Optional OpenTelemetry trace correlation. `Meter` implementations may
   * stamp it via `getActiveTraceId()` from `@agentback/extension-otel`
   * so usage events and traces share one join key.
   */
  traceId?: string;
}

/**
 * Durable destination for usage events. The default is in-memory; a
 * Redis/Kafka/DB sink is a downstream binding. Implementations must be
 * idempotent on {@link UsageEvent.id}.
 */
export interface UsageSink {
  record(event: UsageEvent): void | Promise<void>;
}

/**
 * Per-principal quota — the `metered?` enforcement answer. `check` reports
 * whether a principal may make another call; `consume` records usage.
 */
export interface QuotaService {
  check(
    principalId: string,
    op?: string,
  ):
    | {allowed: boolean; remaining?: number}
    | Promise<{allowed: boolean; remaining?: number}>;
  consume(principalId: string, units: number): void | Promise<void>;
}

/** Construction options for {@link Meter}. */
export interface MeterOptions {
  /** Clock, injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Id generator, injectable for deterministic tests. Default `nanoid`. */
  genId?: () => string;
  /** ISO-timestamp formatter from epoch ms. Default `new Date(ms).toISOString()`. */
  isoTime?: (ms: number) => string;
  /**
   * Active-trace-id provider, sampled at record time and stamped onto each
   * {@link UsageEvent.traceId}. Bind one at
   * `MeteringBindings.TRACE_ID_PROVIDER` (extension-otel does this) rather
   * than constructing meters by hand.
   */
  traceIdProvider?: () => string | undefined;
}
