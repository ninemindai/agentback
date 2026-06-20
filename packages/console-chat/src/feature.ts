// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RestApplication} from '@agentback/rest';
import type {ConsoleFeature} from '@agentback/console';
import type {ChatConsoleConfig} from './types.js';
import {ChatBridgeController} from './bridge.controller.js';
import {discoverAgents, BUILTIN_AGENTS} from './agents.js';

/**
 * Server-side feature for the chat dock.
 *
 * Registers the `ChatBridgeController` REST endpoints and advertises the
 * `window.__CONSOLE__.chat` config block to the browser shell.
 *
 * @param config - Chat dock configuration (all fields optional).
 */
export function chatConsoleFeature(
  config: ChatConsoleConfig = {},
): ConsoleFeature & {
  chatConfig: {enabled: boolean; apiBase: string; agents: {id: string; name: string}[]};
} {
  const enabled = config.enabled ?? false;
  const apiBase = '/console/chat';
  // agents list starts empty; it is populated lazily on first /agents call.
  const agents: {id: string; name: string}[] = [];

  return {
    id: 'chat',
    apiBase,
    extra: {chat: {enabled, apiBase, agents}},

    async install(app: RestApplication): Promise<void> {
      if (!enabled) return;

      // Register the bridge controller.
      app.restController(ChatBridgeController);

      // Eagerly run discovery and update the agents list so the console shell
      // gets an accurate initial set without a round-trip.
      const found = await discoverAgents([
        ...BUILTIN_AGENTS,
        ...(config.agents ?? []),
      ]).catch(() => []);

      agents.splice(0, agents.length, ...found);
    },

    // Expose the typed chat config for window.__CONSOLE__.chat injection.
    chatConfig: {enabled, apiBase, agents},
  };
}
