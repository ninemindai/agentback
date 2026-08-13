// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope} from '@agentback/context';
import {unbindOwned, type Application, type Installed} from '@agentback/core';
import {composeTeardown} from '@agentback/common';
import {AgentBindings} from './keys.js';
import {AgentSessionRegistry} from './session-registry.js';
import {wrapAgent} from './turn.js';
import type {AgentPort} from './port.js';

export interface InstallAgentOptions {
  /**
   * The dev-constructed AI SDK agent (`ToolLoopAgent`, `HarnessAgent`, or
   * anything satisfying {@link AgentPort}). You own its model, credentials,
   * instructions, and tools — this package wires what surrounds the loop,
   * never the loop itself.
   */
  agent: AgentPort;
  /** Metering operation name for turn events. Default `'agent.turn'`. */
  operation?: string;
}

/**
 * Opt an application into the agent recipe:
 *
 * - {@link AgentBindings.AGENT} — the turn-wrapped agent, TRANSIENT so each
 *   injection resolves against the injector's context (a controller gets a
 *   wrapper reading the request's `SecurityBindings.USER`): per-turn
 *   identity, preflight quota, one `'agent'` usage event per turn.
 * - {@link AgentBindings.RAW_AGENT} — the unwrapped agent (escape hatch).
 * - {@link AgentBindings.SESSIONS} — live-session registry; wired into
 *   `app.onStop()` so no harness sandbox outlives the app.
 *
 * Not needed for a one-off `agent.generate()` in a script — install when you
 * want DI injection, session lifecycle, or identity/metering.
 */
export function installAgent(
  app: Application,
  options: InstallAgentOptions,
): Installed {
  const registry = new AgentSessionRegistry();
  const sessionsBinding = app.bind(AgentBindings.SESSIONS.key).to(registry);
  const rawBinding = app.bind(AgentBindings.RAW_AGENT.key).to(options.agent);
  const agentBinding = app
    .bind(AgentBindings.AGENT.key)
    .toDynamicValue(({context}) =>
      wrapAgent(options.agent, context, registry, {
        operation: options.operation,
      }),
    )
    .inScope(BindingScope.TRANSIENT);
  const stopBinding = app.onStop(() => registry.destroyAll());

  // Identity-guarded unbinds: bind() REPLACES at the same key, so if the
  // user (or a reinstall) has since bound over ours, uninstall must leave
  // the newer binding in place — an inverse only retracts what it owns.
  const td = composeTeardown();
  td.push(() => unbindOwned(app, sessionsBinding));
  td.push(() => unbindOwned(app, rawBinding));
  td.push(() => unbindOwned(app, agentBinding));
  td.push(() => unbindOwned(app, stopBinding));
  td.push(() => registry.destroyAll());
  return {uninstall: () => td.run()};
}
