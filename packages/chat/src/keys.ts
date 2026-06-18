// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import {MetadataAccessor} from '@agentback/metadata';
import type {UserProfile} from '@agentback/security';
import type {ChatServer} from './chat.server.js';
import type {ChatLike, ChatSender, ChatThread} from './port.js';

export namespace ChatBindings {
  /** The discovery/registration server. Bound by {@link ChatComponent}. */
  export const SERVER = BindingKey.create<ChatServer>('chat.server');
  /**
   * Optional non-secret mount config. Bind it (typically from
   * `@agentback/config`) and {@link installChat} merges it — explicit
   * `installChat` options still win. Secrets (bot tokens, signing secrets) do
   * **not** belong here: keep them in env, where the chat adapters read them.
   */
  export const CONFIG = BindingKey.create<ChatRuntimeConfig>('chat.config');

  // Per-call bindings: populated in a request-scoped child context for the
  // duration of one event dispatch, so handlers (and the services they inject)
  // can `@inject` them. Inject optionally — they're absent outside a dispatch.

  /** The sender (`message.author` / `event.user`) of the current event. */
  export const SENDER = BindingKey.create<ChatSender>('chat.request.sender');
  /** The thread the current event occurred in. */
  export const THREAD = BindingKey.create<ChatThread>('chat.request.thread');
  /** The raw event the runtime delivered (message or event object). */
  export const EVENT = BindingKey.create<unknown>('chat.request.event');
}

/**
 * Establishes the authenticated principal for an inbound chat event. Configured
 * at the boundary (`installChat`), it runs per dispatch with the sender the
 * runtime parsed from the payload; its result is bound as `SecurityBindings.USER`
 * in the per-call context, so chat authorizes the same way as REST and MCP.
 */
export type ChatPrincipalResolver = (
  sender: ChatSender | undefined,
  context: {event: ChatEvent; thread?: ChatThread | null; raw: unknown},
) => UserProfile | undefined | Promise<UserProfile | undefined>;

/**
 * How a composite runs the multiple handlers registered for one event:
 * - `sequential` (default) — await each in registration order; deterministic.
 * - `parallel` — start all at once (`Promise.allSettled`); faster when handlers
 *   are independent, but post/side-effect order is not guaranteed.
 *
 * Errors are isolated in both modes: one failing handler is logged and never
 * aborts its siblings.
 */
export type ChatDispatch = 'sequential' | 'parallel';

/**
 * Non-secret, file-friendly chat config (the half that belongs in
 * `@agentback/config` overlays). Mount paths and prefixes only — credentials
 * stay in environment variables.
 */
export interface ChatRuntimeConfig {
  /** Path prefix for webhooks. Default `/api/chat` → `/api/chat/<adapter>`. */
  basePath?: string;
  /** Per-adapter absolute path overrides, keyed by adapter name. */
  paths?: Record<string, string>;
  /** How multiple handlers for one event run. Default `sequential`. */
  dispatch?: ChatDispatch;
}

/**
 * Extension-point name for classes that contribute chat handlers. `@chatBot()`
 * tags a class `extensionFor: CHAT_HANDLERS`; {@link ChatServer} discovers them
 * with `extensionFilter(CHAT_HANDLERS)` — exactly how `@agentback/mcp`
 * discovers `@mcpServer` tool classes via `MCP_SERVERS`.
 */
export const CHAT_HANDLERS = 'chatHandlers';

/**
 * The chat events a `@chatBot` method can subscribe to. Each maps to a
 * registration method on the chat runtime (see {@link EVENT_TO_RUNTIME_METHOD}).
 */
export type ChatEvent =
  | 'mention'
  | 'message'
  | 'directMessage'
  | 'action'
  | 'reaction'
  | 'slashCommand';

/** Maps a {@link ChatEvent} to the {@link ChatLike} method that subscribes it. */
export const EVENT_TO_RUNTIME_METHOD: Record<ChatEvent, keyof ChatLike> = {
  mention: 'onNewMention',
  message: 'onSubscribedMessage',
  directMessage: 'onDirectMessage',
  action: 'onAction',
  reaction: 'onReaction',
  slashCommand: 'onSlashCommand',
};

/** Method-level metadata recorded by the handler decorators. */
export interface ChatHandlerMetadata {
  event: ChatEvent;
  methodName: string | symbol;
}

export namespace ChatKeys {
  export const HANDLER = MetadataAccessor.create<
    ChatHandlerMetadata,
    MethodDecorator
  >('chat:handler');
}
