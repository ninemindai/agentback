// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import type {UserProfile} from '@agentback/security';

/**
 * Per-tool context the turn wrapper supplies to every projected host tool
 * (validated by the generated `contextSchema`). Identity is per-turn, never
 * baked at projection time: `principal` and `turnCtx` change on every turn.
 */
export interface AgentToolContext {
  /** The turn's principal — honored by `callTool` for `@authorize` voters. */
  principal?: UserProfile;
  /** Correlation id shared by the turn's `'agent'` and `'mcp'` usage events. */
  turnId?: string;
  /**
   * Turn-scoped DI context (child of the initiating request context). The
   * per-call MCP request child chains off it, so dispatch hooks and
   * method-level `@inject`s see turn-scoped bindings.
   */
  turnCtx?: Context;
}

/**
 * Options for one agent turn. Deliberately minimal — the structural subset
 * both `ToolLoopAgent` and `HarnessAgent` accept. Pass provider-specific
 * options through the raw agent (bound at `AgentBindings.RAW_AGENT`) when
 * you need more than the port models.
 */
export interface AgentTurnOptions {
  prompt?: unknown;
  messages?: unknown;
  /**
   * Per-tool context map keyed by tool name. The turn wrapper auto-fills
   * entries for projected tools; caller-supplied entries win per tool.
   */
  toolsContext?: Record<string, unknown>;
}

/** The structural subset of an AI SDK `GenerateTextResult` the port relies on. */
export interface AgentTurnResult {
  text: string;
  usage?: unknown;
  steps?: unknown;
}

/** A live agent session (HarnessAgent) — tracked so `app.stop()` destroys it. */
export interface AgentSessionLike {
  destroy(): Promise<void> | void;
}

/**
 * Structural port over the AI SDK `Agent` interface — `ToolLoopAgent`,
 * `HarnessAgent`, or anything shape-compatible satisfies it, so `ai` types
 * never enter this package's public DI surface (the `ChatLike` discipline).
 */
export interface AgentPort {
  generate(options: AgentTurnOptions): Promise<AgentTurnResult>;
  stream?(options: AgentTurnOptions): Promise<unknown>;
  createSession?(): Promise<AgentSessionLike>;
  /** The agent's tool set (AI SDK agents expose this) — used to key toolsContext. */
  readonly tools?: Record<string, unknown>;
}
