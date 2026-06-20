// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RestApplication} from '@agentback/rest';
import type {ConsoleFeature} from '@agentback/console';
import type {ChatConsoleConfig} from './types.js';

/**
 * Stub server-side feature for the chat dock.
 *
 * Phase 2 (Tasks 5/6) will fill in agent discovery, the ACP bridge
 * controller, and session lifecycle.  This scaffold:
 * - Satisfies the {@link ConsoleFeature} interface so the console shell can
 *   include the dock configuration.
 * - Returns an empty `chat` config block (no agents discovered yet) — the
 *   dock renders only when `chat.enabled && agents.length > 0`.
 *
 * @param config - Chat dock configuration (all fields optional).
 */
export function chatConsoleFeature(
  config: ChatConsoleConfig = {},
): ConsoleFeature & {chatConfig: {enabled: boolean; apiBase: string; agents: {id: string; name: string}[]}} {
  const enabled = config.enabled ?? false;
  const apiBase = '/console/chat';
  const agents: {id: string; name: string}[] = [];

  return {
    id: 'chat',
    apiBase,
    extra: {chat: {enabled, apiBase, agents}},

    install(_app: RestApplication): void {
      // Bridge endpoints (GET /agents, GET /stream, POST /message,
      // POST /permission, POST /session, DELETE /session) registered in Task 5.
    },

    // Expose the typed chat config for the console's window.__CONSOLE__.chat
    // injection (Tasks 3/4 will wire this into installConsole).
    chatConfig: {enabled, apiBase, agents},
  };
}
