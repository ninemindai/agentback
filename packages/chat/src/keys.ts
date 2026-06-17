// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import {MetadataAccessor} from '@agentback/metadata';
import type {ChatServer} from './chat.server.js';
import type {ChatLike} from './port.js';

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
}

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
