// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * @agentback/console-chat
 *
 * ACP agent dock for the unified developer console (`@agentback/console`).
 * Node-host-only — spawns an ACP coding-agent subprocess and bridges it to
 * the browser over SSE + POST.  Edge/fetch-host applications cannot use this
 * package; the dock is absent when chat is not enabled.
 *
 * Phase 2 of the console-chat ACP plan (see docs/superpowers/specs/
 * 2026-06-19-console-chat-acp-design.md).  This module exports the server-
 * side `chatConsoleFeature()` factory that registers the bridge controller
 * and advertises `window.__CONSOLE__.chat` to the shell.
 *
 * Implementation of the bridge endpoints (SSE stream, POST message/
 * permission, agent discovery, session lifecycle) is Task 5/6.  This
 * scaffold exports the config type and a stub factory so the package builds
 * and the console shell can gate the dock region.
 */

export type {ChatConsoleConfig} from './types.js';
export {chatConsoleFeature} from './feature.js';
