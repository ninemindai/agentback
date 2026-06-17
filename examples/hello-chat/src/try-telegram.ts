// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Zero-tunnel local tryout: run a real Telegram bot in POLLING mode.
// Polling needs no public webhook, so we use the package's ChatServer to
// register @chatBot handlers directly (no HTTP mount) and then start polling.
//
//   1. Create a bot with @BotFather, copy the token.
//   2. TELEGRAM_BOT_TOKEN=... npm run start:telegram
//   3. DM your bot — it replies through the AgentBack DI handler.

import {RestApplication} from '@agentback/rest';
import {ChatBindings, ChatComponent, type ChatServer} from '@agentback/chat';
import {Chat} from 'chat';
import {createTelegramAdapter} from '@chat-adapter/telegram';
import {createMemoryState} from '@chat-adapter/state-memory';
import {GreetingService} from './greeting.service.js';
import {SupportBot} from './support-bot.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Set TELEGRAM_BOT_TOKEN (from @BotFather).');
  process.exit(1);
}

// A DI container holding the @chatBot service + ChatComponent (no HTTP needed).
const app = new RestApplication();
app.component(ChatComponent);
app.service(GreetingService);
app.service(SupportBot);

const chat = new Chat({
  userName: 'agentback_bot',
  adapters: {
    telegram: createTelegramAdapter({botToken: token, mode: 'polling'}),
  },
  state: createMemoryState(),
});

// Wire @chatBot handlers onto the runtime (the discovery half of installChat,
// without the webhook mount that polling doesn't need), then start polling.
const server = await app.get<ChatServer>(ChatBindings.SERVER);
await server.register(chat);
await chat.initialize();

console.log('Polling Telegram — DM your bot now. Ctrl-C to stop.');
process.on('SIGINT', () => {
  void chat.shutdown().finally(() => process.exit(0));
});
