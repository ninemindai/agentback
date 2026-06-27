// Copyright NineMind, Inc. 2026. All Rights Reserved.
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
 */

export type {ChatConsoleConfig} from './types.js';
export {chatConsoleFeature} from './feature.js';
export {
  BUILTIN_AGENTS,
  discoverAgents,
  doctor,
  defaultProbe,
} from './agents.js';
export type {AgentDescriptor, RunProbe, ProbeResult, DoctorResult} from './agents.js';

// ACP session
export {
  AcpSession,
  SpawnError,
  AcpHandshakeError,
  PartialTurnError,
  defaultConnectFn,
} from './acp-session.js';
export type {
  AcpEvent,
  AssistantDeltaEvent,
  ToolCallEvent,
  PermissionRequestEvent,
  StopEvent,
  ErrorEvent,
  AcpConnectFn,
  AcpConnectOptions,
} from './acp-session.js';

// Bridge controller
export {ChatBridgeController, CHAT_CONNECT_FN, CHAT_DISCOVER, CHAT_CWD, CHAT_WORKSPACE_ROOT} from './bridge.controller.js';
export type {DiscoverFn} from './bridge.controller.js';
