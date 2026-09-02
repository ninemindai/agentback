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
  /**
   * Cancellation for the turn, forwarded to the AI SDK so an abort stops the
   * model mid-generation rather than at the next step boundary.
   *
   * The turn wrapper fills this in from `CoreBindings.ABORT_SIGNAL` on the
   * resolution context when the caller leaves it unset — so a REST caller who
   * hangs up stops the bill, not just the reading. An explicit value wins.
   */
  abortSignal?: AbortSignal;
  /**
   * Token ceiling for this turn, enforced by `@agentback/model-gateway`'s
   * accounting policy when the agent's model is gateway-wrapped (a plain model
   * has nothing to enforce it).
   *
   * An agent loop has no natural end and a step cap counts steps, not spend:
   * one step can be 500 tokens or 500,000. A bounded failure beats an
   * unbounded bill.
   */
  tokenBudget?: number;
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
