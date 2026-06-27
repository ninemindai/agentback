// Copyright NineMind, Inc. 2026. All Rights Reserved.
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
  detect: {bin: string; args?: string[]; minVersion?: string};
  /** ACP launch command (the adapter, not the underlying model CLI). */
  command: string[];
  /**
   * npm package to install when the binary is absent or out-of-date.
   * Defaults to the binary name (`detect.bin`) when omitted.
   * Use when the published package name differs from the bin name
   * (e.g. bin `claude-agent-acp` ships in `@agentclientprotocol/claude-agent-acp`).
   */
  installPackage?: string;
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
   * Adapter-discovery base directory.
   *
   * Used as the base dir for PATH augmentation during agent discovery and
   * spawn, so that a workspace devDependency adapter (whose bin pnpm isolates
   * under the consumer package's `node_modules/.bin`) is found without a
   * global install.  Defaults to `process.cwd()`.
   *
   * This is NOT the agent's editing root — for that, see `workspaceRoot`.
   */
  cwd?: string;
  /**
   * The coding agent's working/editing root, passed as the ACP `session/new`
   * cwd — where the agent reads and edits source.
   *
   * This is the source tree backing the running app and acts as a security
   * containment boundary: the agent operates within this tree.
   * Server-controlled; defaults to `process.cwd()`.
   *
   * For a standalone AgentBack service set this to its own repo root.  In a
   * monorepo, set it to the repo root (so the agent can evolve both the app
   * AND the framework packages it depends on), NOT a narrow subdir.
   *
   * The client (browser dock) cannot choose the agent root — only the server
   * configuration sets it.
   */
  workspaceRoot?: string;
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
