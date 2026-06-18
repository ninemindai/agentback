// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * `@agentback/chat` — chat platforms (Slack, Discord, Telegram, Teams, …) as a
 * third inbound surface over the same DI container that serves REST and MCP.
 *
 * Transport-agnostic: it depends on no chat SDK. A consumer passes their
 * configured chat runtime (Vercel Chat SDK `new Chat({adapters})`, which
 * satisfies the {@link ChatLike} port by shape) to {@link installChat}. The
 * package supplies discovery (`@chatBot` + extension point), DI-resolved
 * handlers, the fetch-native webhook mount (with raw-body capture for signed
 * adapters), and lifecycle — never the agent loop, which lives in the handler.
 *
 * @example
 * ```ts
 * import {RestApplication} from '@agentback/rest';
 * import {ChatComponent, installChat, chatJsonVerify, chatBot, onMention} from '@agentback/chat';
 * import {Chat} from 'chat';
 * import {createSlackAdapter} from '@chat-adapter/slack';
 *
 * @chatBot()
 * class SupportBot {
 *   @onMention()
 *   async hi(thread, message) { await thread.post(`echo: ${message.text}`); }
 * }
 *
 * const app = new RestApplication({rest: {bodyParser: {json: {verify: chatJsonVerify}}}});
 * app.component(ChatComponent);
 * app.service(SupportBot);
 * await installChat(app, {chat: new Chat({adapters: {slack: createSlackAdapter()}})});
 * await app.start(); // POST /api/chat/slack
 * ```
 */

export * from './keys.js';
export * from './port.js';
export * from './decorators/index.js';
export {ChatServer, type ChatHandlerBinding} from './chat.server.js';
export {ChatComponent} from './chat.component.js';
export {
  installChat,
  mountChatWebhooks,
  chatJsonVerify,
  type InstallChatOptions,
  type ChatHttpHandle,
} from './install.js';
