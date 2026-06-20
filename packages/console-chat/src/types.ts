// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Descriptor for a known ACP agent.  The built-in catalog ships a set of
 * these; callers may extend via `ChatConsoleConfig.agents`.
 */
export interface AgentDescriptor {
  id: string;
  name: string;
  /** Read-only probe to check whether the agent is available on this machine. */
  detect: {bin: string; args?: string[]};
  /** ACP launch command (the adapter, not the underlying model CLI). */
  command: string[];
}

/**
 * Options passed to `chatConsoleFeature()`.
 *
 * All properties are optional because the dock is hidden when chat is absent
 * or no agent is discovered — callers opt in by passing `enabled: true`.
 */
export interface ChatConsoleConfig {
  /** Gate the chat dock (default: false). */
  enabled?: boolean;
  /**
   * Working directory for the spawned agent subprocess.
   * Defaults to `process.cwd()` (the project root).
   */
  cwd?: string;
  /**
   * Mount the in-process introspection MCP as a grounding server for the
   * agent session (default: true).
   */
  introspection?: boolean;
  /**
   * Additional custom agent descriptors to add to the built-in catalog.
   * Discovery unions these with the built-in entries, filtered by `detect`.
   */
  agents?: AgentDescriptor[];
}
