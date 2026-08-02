// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ConsoleFeature} from '@agentback/console';
import type {RestApplication} from '@agentback/rest';
import {AgentPlaygroundController} from './turn.controller.js';

/**
 * Console panel that runs one turn of **the app's own agent** against **the
 * app's own tools**, in the running process.
 *
 * ## Not the chat dock
 *
 * `@agentback/console-chat` and this package both put an agent in the console
 * and they are not the same thing:
 *
 * | | `console-chat` (dock) | `console-agents` (this) |
 * | --- | --- | --- |
 * | Whose agent | a **coding** agent (Claude Code, …) | **your app's**, via `installAgent` |
 * | What it acts on | your **source tree**, over ACP | your **`@tool`s**, in-process |
 * | Where it runs | a spawned subprocess | this process's DI container |
 * | Point of it | evolve the app | see the app work |
 *
 * The dock writes code; this runs the thing the code produced. They compose —
 * edit in the dock, exercise here — which is why they are separate panels and
 * not one.
 *
 * ## Off by default
 *
 * This panel *executes*: it spends model tokens and invokes real tools with
 * real side effects, as the console operator. So it is opt-in, and the console's
 * existing auth gate applies to its endpoints like every other panel's. Enabling
 * it on a publicly reachable console hands strangers your tools and your
 * provider bill — keep the console behind real auth or on loopback.
 *
 * ```ts
 * import {installAgent} from '@agentback/agents';
 * import {agentsConsoleFeature} from '@agentback/console-agents';
 *
 * installAgent(app, {agent: myAgent});
 * await installConsole(app, {
 *   features: [...defaultFeatures(), agentsConsoleFeature({enabled: true})],
 * });
 * ```
 */
export interface AgentsConsoleConfig {
  /** Mount the playground. Default `false` — it executes tools and spends money. */
  enabled?: boolean;
}

export function agentsConsoleFeature(
  config: AgentsConsoleConfig = {},
): ConsoleFeature {
  const enabled = config.enabled ?? false;
  return {
    id: 'agents',
    apiBase: '/console/agents/api',
    // The page is statically bundled into the console SPA, so it cannot be
    // omitted at build time — it reads this to decide between a prompt box and
    // an explanation of what to turn on.
    extra: {enabled},
    install(app: RestApplication): void {
      if (!enabled) return;
      app.controller(AgentPlaygroundController);
    },
  };
}
