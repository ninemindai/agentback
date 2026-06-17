// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {injectable} from '@agentback/context';
import {service} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {
  ChatComponent,
  chatBot,
  onMention,
  onAction,
  chatJsonVerify,
  installChat,
  ChatBindings,
  ChatServer,
} from '../../index.js';
import type {
  ChatActionEvent,
  ChatLike,
  ChatRuntimeHandler,
  ChatThread,
  ChatMessage,
} from '../../index.js';

// A DI service the bot reaches — proves constructor injection through the container.
@injectable()
class GreetingService {
  greet(name: string): string {
    return `hello ${name}`;
  }
}

@chatBot()
class TestBot {
  constructor(@service(GreetingService) private greeting: GreetingService) {}
  readonly seen: string[] = [];

  @onMention()
  async onMentionHandler(
    thread: ChatThread,
    message: ChatMessage,
  ): Promise<void> {
    const reply = this.greeting.greet(message.text ?? 'world');
    this.seen.push(reply);
    await thread.post(reply);
  }

  @onAction()
  async onActionHandler(_event: ChatActionEvent): Promise<void> {
    this.seen.push('action');
  }
}

// Compile-time enforcement, verified by `tsc -b` (an unused @ts-expect-error
// fails the build). Kept off TestBot so it doesn't register extra handlers.
class SignatureChecks {
  @onMention()
  okMessage(_thread: ChatThread, _message: ChatMessage): void {}

  // @ts-expect-error message must be a ChatMessage, not a number
  @onMention()
  wrongMessageType(_thread: ChatThread, _message: number): void {}

  // @ts-expect-error a handler cannot declare params the runtime won't pass
  @onMention()
  tooManyParams(_t: ChatThread, _m: ChatMessage, _extra: string): void {}
}

// Two mention handlers on one class; the first throws. Used to prove the
// composite runs all handlers for an event and isolates failures.
@chatBot()
class FanOutBot {
  readonly ran: string[] = [];
  @onMention()
  async first(_thread: ChatThread, _message: ChatMessage): Promise<void> {
    this.ran.push('first');
    throw new Error('boom');
  }
  @onMention()
  async second(_thread: ChatThread, _message: ChatMessage): Promise<void> {
    this.ran.push('second');
  }
}

/**
 * Stub chat runtime: records subscribed handlers and exposes a fetch-native
 * webhook that dispatches a synthetic "mention" payload to the mention handler.
 * No real adapter / network — the seam under test is mount → bridge → handler.
 */
class StubChat implements ChatLike {
  mention?: ChatRuntimeHandler;
  posted: unknown[] = [];
  shutdownCalled = false;

  onNewMention(h: ChatRuntimeHandler): void {
    this.mention = h;
  }
  // present so register() can wire @onAction; unused in assertions
  onAction(_h: ChatRuntimeHandler): void {}

  shutdown(): Promise<void> {
    this.shutdownCalled = true;
    return Promise.resolve();
  }

  webhooks = {
    test: async (request: Request): Promise<Response> => {
      const payload = (await request.json()) as {kind?: string; text?: string};
      if (payload.kind === 'mention' && this.mention) {
        const thread: ChatThread = {
          post: async c => {
            this.posted.push(c);
            return undefined;
          },
          id: 't1',
        };
        await this.mention(thread, {text: payload.text, isMention: true});
      }
      return new Response('ok', {status: 200});
    },
  };
}

async function bootApp(
  chat: ChatLike,
): Promise<{app: RestApplication; url: string}> {
  const app = new RestApplication({
    rest: {
      port: 0,
      host: '127.0.0.1',
      bodyParser: {json: {verify: chatJsonVerify}},
    },
  });
  app.component(ChatComponent);
  app.service(GreetingService);
  app.service(TestBot);
  await installChat(app, {chat});
  await app.start();
  const server = await app.restServer;
  return {app, url: server.url};
}

describe('@agentback/chat', () => {
  it('enforces handler signatures at compile time', () => {
    // The @ts-expect-error lines in SignatureChecks fail `tsc -b` if the typed
    // decorators stop rejecting bad signatures; this keeps the class referenced.
    expect(typeof SignatureChecks).toBe('function');
  });

  it('chatJsonVerify captures raw bytes on req.rawBody', () => {
    const req: {rawBody?: Buffer} = {};
    const buf = Buffer.from('{"a":1}');
    chatJsonVerify(req, {}, buf);
    expect(req.rawBody).toBe(buf);
  });

  it('discovers @chatBot handlers and wires them to the runtime', async () => {
    const chat = new StubChat();
    const app = new RestApplication();
    app.component(ChatComponent);
    app.service(GreetingService);
    app.service(TestBot);
    const server = await app.get<ChatServer>(ChatBindings.SERVER);
    await server.register(chat);
    const events = server
      .listHandlers()
      .map(h => h.meta.event)
      .sort();
    expect(events).toEqual(['action', 'mention']);
    expect(typeof chat.mention).toBe('function');
  });

  it('routes a webhook through Express to the DI-resolved handler', async () => {
    const chat = new StubChat();
    const {app, url} = await bootApp(chat);
    try {
      const res = await fetch(`${url}/api/chat/test`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({kind: 'mention', text: 'agentback'}),
      });
      expect(res.status).toBe(200);
      const bot = await app.get<TestBot>('services.TestBot');
      expect(bot.seen).toEqual(['hello agentback']);
      expect(chat.posted).toEqual(['hello agentback']);
    } finally {
      await app.stop();
    }
    expect(chat.shutdownCalled).toBe(true);
  });

  it('merges basePath from a bound ChatBindings.CONFIG (config seam)', async () => {
    const chat = new StubChat();
    const app = new RestApplication({
      rest: {
        port: 0,
        host: '127.0.0.1',
        bodyParser: {json: {verify: chatJsonVerify}},
      },
    });
    app.component(ChatComponent);
    app.service(GreetingService);
    app.service(TestBot);
    // Simulate @agentback/config populating the binding.
    app.bind(ChatBindings.CONFIG).to({basePath: '/hooks'});
    const handle = await installChat(app, {chat});
    await app.start();
    try {
      expect(handle.paths.test).toBe('/hooks/test');
      const server = await app.restServer;
      const res = await fetch(`${server.url}/hooks/test`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({kind: 'mention', text: 'cfg'}),
      });
      expect(res.status).toBe(200);
      const bot = await app.get<TestBot>('services.TestBot');
      expect(bot.seen).toEqual(['hello cfg']);
    } finally {
      await app.stop();
    }
  });

  it('runs every handler for an event and isolates errors (sequential)', async () => {
    const chat = new StubChat();
    const app = new RestApplication();
    app.component(ChatComponent);
    app.service(FanOutBot);
    const server = await app.get<ChatServer>(ChatBindings.SERVER);
    await server.register(chat); // default: sequential
    const bot = await app.get<FanOutBot>('services.FanOutBot');
    const thread = {post: async () => undefined} as ChatThread;
    // The composite is the single registered mention handler.
    await chat.mention!(thread, {text: 'hi'});
    // 'second' ran despite 'first' throwing — error isolated, order preserved.
    expect(bot.ran).toEqual(['first', 'second']);
  });

  it('supports parallel dispatch', async () => {
    const chat = new StubChat();
    const app = new RestApplication();
    app.component(ChatComponent);
    app.service(FanOutBot);
    const server = await app.get<ChatServer>(ChatBindings.SERVER);
    await server.register(chat, 'parallel');
    const bot = await app.get<FanOutBot>('services.FanOutBot');
    const thread = {post: async () => undefined} as ChatThread;
    await chat.mention!(thread, {text: 'hi'});
    expect([...bot.ran].sort()).toEqual(['first', 'second']); // both ran; order not guaranteed
  });

  it('preserves exact request bytes end-to-end (raw-body path)', async () => {
    // A body whose re-serialization would differ (extra spaces, key order).
    const chat = new StubChat();
    let receivedRaw = '';
    chat.webhooks.test = async (request: Request): Promise<Response> => {
      receivedRaw = await request.text();
      return new Response('ok', {status: 200});
    };
    const {app, url} = await bootApp(chat);
    const wireBody = '{"kind":"mention",  "text":"x",\n"z":1}';
    try {
      await fetch(`${url}/api/chat/test`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: wireBody,
      });
      // Exact bytes round-tripped — not JSON.stringify(parsed).
      expect(receivedRaw).toBe(wireBody);
    } finally {
      await app.stop();
    }
  });
});
