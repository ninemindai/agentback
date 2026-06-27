// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-chat — chat platforms as a third inbound surface over the AgentBack DI
// container (alongside REST and MCP). This entrypoint shows the canonical
// WEBHOOK setup: installChat mounts each adapter's webhook on the RestServer's
// Express. For a zero-tunnel local try, see `npm run start:telegram` (polling).

import {isMain} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {securityId} from '@agentback/security';
import {ChatComponent, chatJsonVerify, installChat} from '@agentback/chat';
import {Chat} from 'chat';
import {createTelegramAdapter} from '@chat-adapter/telegram';
import {createSlackAdapter} from '@chat-adapter/slack';
import {createMemoryState} from '@chat-adapter/state-memory';
import {GreetingService} from './greeting.service.js';
import {SupportBot} from './support-bot.js';

export async function main(): Promise<void> {
  // chatJsonVerify captures raw bytes so signature adapters (Slack/Teams HMAC)
  // verify behind AgentBack's JSON parser.
  const app = new RestApplication({
    rest: {bodyParser: {json: {verify: chatJsonVerify}}},
  });
  app.component(ChatComponent);
  app.service(GreetingService);
  app.service(SupportBot);

  // Enable only the adapters whose credentials are present (adapters auto-read
  // their env vars: TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET).
  const adapters: Record<
    string,
    | ReturnType<typeof createTelegramAdapter>
    | ReturnType<typeof createSlackAdapter>
  > = {};
  if (process.env.TELEGRAM_BOT_TOKEN) {
    adapters.telegram = createTelegramAdapter({mode: 'webhook'});
  }
  if (process.env.SLACK_SIGNING_SECRET) {
    adapters.slack = createSlackAdapter({mode: 'webhook'});
  }
  if (Object.keys(adapters).length === 0) {
    console.error(
      'No chat credentials found. Set TELEGRAM_BOT_TOKEN and/or ' +
        'SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET, then re-run. See README.',
    );
    process.exit(1);
  }

  const chat = new Chat({
    userName: 'agentback_bot',
    adapters,
    state: createMemoryState(),
  });

  const handle = await installChat(app, {
    chat,
    // Establish the principal from the parsed sender — the chat analog of an
    // auth guard. A real app would look the user up / map roles here.
    principal: sender =>
      sender
        ? {[securityId]: sender.userId, name: sender.userName ?? sender.userId}
        : undefined,
  });
  await app.start();

  const {url} = await app.restServer;
  console.log(`hello-chat up at ${url}`);
  for (const [name, path] of Object.entries(handle.paths)) {
    console.log(`  ${name} webhook: POST ${url}${path}`);
  }
  console.log(
    'Point each platform at its webhook URL (use a tunnel for local dev). See README.',
  );
}

if (isMain(import.meta)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
