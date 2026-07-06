// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import {loggers} from '@agentback/common';
import {Context} from '@agentback/context';
import {SecurityBindings} from '@agentback/security';
import {
  MeteringBindings,
  principalFromContext,
  type Meter,
  type QuotaService,
  type UsageDescriptor,
} from '@agentback/metering';
import {isProjectedTool} from './host-tools.js';
import type {AgentPort, AgentToolContext, AgentTurnOptions} from './port.js';
import type {AgentSessionRegistry} from './session-registry.js';

const log = loggers('agentback:agents:turn');

export interface AgentTurnConfig {
  /** Metering operation name for turn events. Default `'agent.turn'`. */
  operation?: string;
}

interface PreparedTurn {
  options: AgentTurnOptions;
  meter?: Meter;
  descriptor: () => UsageDescriptor;
  /** Post-turn quota charge (success only — metering records failures). */
  succeed: () => Promise<void>;
}

/**
 * Wrap a dev-constructed agent for one resolution context. Resolved TRANSIENT
 * per injection, so `ctx` is the injector's context — in a controller that is
 * the per-request child carrying `SecurityBindings.USER`. Each turn:
 *
 * 1. reads the principal from `ctx` (per-turn identity, D6/D21),
 * 2. checks quota PREFLIGHT — before the LLM call spends money,
 * 3. builds a turn-scoped child context (turn id + principal) and supplies
 *    `toolsContext` entries for every projected tool,
 * 4. records one `'agent'` usage event via the bound Meter (when present),
 * 5. charges quota post-turn on success.
 *
 * Tool-call `'mcp'` events share the turn's principal and correlation id via
 * the turn context — the MCP metering hook reads both through the chain walk.
 */
export function wrapAgent(
  raw: AgentPort,
  ctx: Context,
  registry: AgentSessionRegistry,
  cfg: AgentTurnConfig = {},
): AgentPort {
  const port: AgentPort = {
    get tools() {
      return raw.tools;
    },
    async generate(options: AgentTurnOptions) {
      const turn = await prepareTurn(raw, ctx, options, cfg);
      const run = () => raw.generate(turn.options);
      const result = turn.meter
        ? await turn.meter.observe(turn.descriptor, run)
        : await run();
      await turn.succeed();
      return result;
    },
  };
  if (raw.stream) {
    port.stream = async (options: AgentTurnOptions) => {
      const turn = await prepareTurn(raw, ctx, options, cfg);
      const result = (await raw.stream!(turn.options)) as {
        finishReason?: Promise<unknown>;
      };
      // Detached finalization: the stream's usage is only knowable at
      // completion or cancellation. `finishReason` settles on both (an abort
      // rejects it), so metering records the turn and quota charges exactly
      // once, whichever way the stream ends.
      const settled = Promise.resolve(result?.finishReason);
      const finalize = turn.meter
        ? turn.meter.observe(turn.descriptor, () => settled)
        : settled;
      void finalize
        .then(() => turn.succeed())
        .catch(err => {
          if (log.debug.enabled)
            log.debug('stream turn ended in error: %s', err);
        });
      return result;
    };
  }
  if (raw.createSession) {
    port.createSession = async () => {
      const session = await raw.createSession!();
      return registry.register(session);
    };
  }
  return port;
}

async function prepareTurn(
  raw: AgentPort,
  ctx: Context,
  options: AgentTurnOptions,
  cfg: AgentTurnConfig,
): Promise<PreparedTurn> {
  // Per-turn identity from the resolution (request) context. USER may be
  // absent — the turn then runs anonymous, exactly like an unauthenticated
  // MCP call.
  const user = ctx.getSync(SecurityBindings.USER, {optional: true});
  const principal = principalFromContext(ctx);

  // PREFLIGHT quota — deny before the model call spends money.
  const quota = (await ctx.get(MeteringBindings.QUOTA, {
    optional: true,
  })) as QuotaService | undefined;
  if (quota) {
    const {allowed} = await quota.check(principal.id);
    if (!allowed) {
      const err = new Error(
        `Agent turn quota exceeded for principal '${principal.id}'.`,
      );
      Object.assign(err, {statusCode: 429, code: 'quota_exceeded'});
      throw err;
    }
  }

  const turnId = randomUUID();
  const turnCtx = new Context(ctx, 'agent.turn');
  if (user) turnCtx.bind(SecurityBindings.USER).to(user);
  turnCtx.bind(MeteringBindings.CORRELATION_ID.key).to(turnId);

  // toolsContext entries for every projected tool on the agent; entries the
  // caller supplied win per tool.
  const generated: Record<string, AgentToolContext> = {};
  const toolContext: AgentToolContext = {principal: user, turnId, turnCtx};
  for (const [name, t] of Object.entries(raw.tools ?? {})) {
    if (isProjectedTool(t)) generated[name] = toolContext;
  }
  const toolsContext = {...generated, ...(options.toolsContext ?? {})};

  const meter = (await ctx.get(MeteringBindings.METER, {
    optional: true,
  })) as Meter | undefined;

  return {
    options: Object.keys(toolsContext).length
      ? {...options, toolsContext}
      : options,
    meter,
    descriptor: () => ({
      surface: 'agent' as const,
      operation: cfg.operation ?? 'agent.turn',
      principal,
      meta: {correlationId: turnId},
    }),
    succeed: async () => {
      if (quota) await quota.consume(principal.id, 1);
    },
  };
}
