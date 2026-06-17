# @agentback/chat

Chat platforms — **Slack, Discord, Telegram, Microsoft Teams, WhatsApp, Linear, …** — as a **third inbound surface** over the same DI container that already serves your REST routes and MCP tools.

A `@chatBot` handler is a DI service: it `@inject`s the same Drizzle client, config, and services your REST controllers and `@tool`s use. One bot, many platforms.

```
REST  (humans/programs) ─┐
MCP   (agents)           ├─►  one DI container · one set of services
CHAT  (chat platforms)  ─┘
```

## What this package does — and deliberately doesn't

It is **transport + wiring**, not an agent loop:

- ✅ Discovers `@chatBot` classes (extension point, like `@mcpServer`) and resolves them through DI.
- ✅ Mounts each platform's webhook on the RestServer's Express (fetch-native bridge).
- ✅ Captures the **raw request body** so signature-verifying adapters (Slack/Teams HMAC) work behind AgentBack's JSON parser.
- ✅ Wires graceful shutdown to `app.onStop()`.
- ✅ Reads optional non-secret config from `@agentback/config`.
- ❌ Does **not** generate replies. What you `thread.post(...)` — an AI SDK stream, a deterministic `@tool` call, a remote agent — is your handler's job.

It takes **no dependency on the chat SDK**: it is structurally typed against a `ChatLike` port, so the (public-beta) Chat SDK's churn never reaches your code. You bring [`chat`](https://github.com/vercel/chat) + the adapters you want.

## Install

```bash
npm i @agentback/chat chat
# plus the adapters you use:
npm i @chat-adapter/slack @chat-adapter/telegram @chat-adapter/discord @chat-adapter/state-memory
```

Published adapters: `@chat-adapter/{slack,discord,telegram,teams,whatsapp,linear}` and state stores `@chat-adapter/{state-memory,state-redis}`.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {
  ChatComponent,
  installChat,
  chatJsonVerify,
  chatBot,
  onMention,
  onAction,
  type ChatThread,
  type ChatMessage,
} from '@agentback/chat';
import {Chat} from 'chat';
import {createSlackAdapter} from '@chat-adapter/slack';
import {createTelegramAdapter} from '@chat-adapter/telegram';
import {createDiscordAdapter} from '@chat-adapter/discord';
import {createMemoryState} from '@chat-adapter/state-memory';

@chatBot()
class SupportBot {
  constructor(@service(TicketService) private tickets: TicketService) {}

  @onMention()
  async handle(thread: ChatThread, message: ChatMessage) {
    const open = await this.tickets.countOpen(); // same DI service your REST/MCP use
    await thread.post(`You have ${open} open tickets.`); // ← your reply logic / AI SDK stream
  }
}

// chatJsonVerify captures raw bytes — required for Slack/Teams signature checks.
const app = new RestApplication({
  rest: {bodyParser: {json: {verify: chatJsonVerify}}},
});
app.component(ChatComponent);
app.service(SupportBot);

const chat = new Chat({
  state: createMemoryState(),
  adapters: {
    slack: createSlackAdapter(), // auto-reads SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET
    telegram: createTelegramAdapter(), // auto-reads TELEGRAM_BOT_TOKEN
    discord: createDiscordAdapter(),
  },
});

await installChat(app, {chat}); // mounts POST /api/chat/{slack,telegram,discord}
await app.start();
```

`installChat` mounts one webhook per adapter at `<basePath>/<adapter>` (default base `/api/chat`).

## Handler decorators

| Decorator            | Chat runtime method   | Typical signature         |
| -------------------- | --------------------- | ------------------------- |
| `@onMention()`       | `onNewMention`        | `(thread, message)`       |
| `@onMessage()`       | `onSubscribedMessage` | `(thread, message)`       |
| `@onDirectMessage()` | `onDirectMessage`     | `(thread, message)`       |
| `@onAction()`        | `onAction`            | `(event)` — button clicks |
| `@onReaction()`      | `onReaction`          | `(event)`                 |
| `@onSlashCommand()`  | `onSlashCommand`      | `(event)`                 |

An event whose method the runtime doesn't expose is skipped with a warning. Use `onChatEvent('<event>')` for the generic form. Signatures are checked at the decorator (a wrong event-arg type errors there, like `@tool`); trailing `@inject(...)` params are allowed.

## Per-call context: principal, injection, dispatch

Each event dispatches in a **per-call child context**. The composite binds the sender/thread/event and — via the `principal` resolver you configure at `installChat` — `SecurityBindings.USER`, so chat authorizes the same way as REST and MCP. Handlers (and the services they inject) read these via `@inject`; the resolver runs at dispatch with the sender the runtime parsed.

```ts
await installChat(app, {
  chat,
  principal: sender =>
    sender ? {[securityId]: sender.userId, name: sender.userName} : undefined,
  dispatch: 'parallel', // or 'sequential' (default)
});

@chatBot() // SINGLETON by default
class SupportBot {
  @onMention()
  async handle(
    thread: ChatThread,
    message: ChatMessage,
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ) {
    /* user is the per-call principal */
  }
}
```

**Constructor vs method injection depends on scope** (a singleton's constructor only sees app-level deps):

- `SINGLETON` (default) — read per-call values via **method** `@inject` (shown above).
- `@chatBot({scope: BindingScope.TRANSIENT})` — the instance is resolved per call, so **constructor** `@inject` gets them too.

**Dispatch** controls how multiple handlers for one event run — `sequential` (default, ordered) or `parallel` (`Promise.allSettled`). **Errors are isolated either way**: a throwing handler is logged and never aborts its siblings.

## Configuration: secrets vs structure

A deliberate split:

- **Secrets** (bot tokens, signing secrets) → **environment variables**, never config files. The chat adapters auto-detect them (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `TELEGRAM_BOT_TOKEN`, …). Keep them in your secret manager / `.env`.
- **Structure** (webhook base path, per-adapter path overrides) → file-friendly, and `@agentback/config` can supply it. Bind `ChatBindings.CONFIG` and `installChat` merges it (explicit `installChat` options win):

```ts
import {ChatBindings} from '@agentback/chat';

// e.g. populated by @agentback/config from a layered YAML/JSONC overlay
app.bind(ChatBindings.CONFIG).to({
  basePath: '/hooks',
  paths: {slack: '/hooks/slack-events'},
  dispatch: 'sequential',
});
```

So: `@agentback/config` is **optional** and used only for the non-secret half; credentials always come from env.

## Raw body (why `chatJsonVerify`)

AgentBack's JSON body parser consumes the request stream before your route runs. Telegram only does a header (secret-token) check, but **Slack and Teams HMAC the exact raw bytes** — re-serializing the parsed body (whitespace/key order differ) fails verification. `chatJsonVerify` is an `express.json({verify})` hook that stashes the exact buffer on `req.rawBody`, which the webhook bridge forwards verbatim. Always pass it when a signing adapter is mounted; `installChat` warns once if it sees a request with no captured raw body.

## Boundary recap

`@agentback/chat` is the back-of-house wiring (transport · DI · config · lifecycle · port). The brain — how a reply is produced — stays in your handler. That keeps one stable contract here instead of coupling to a fast-moving agent runtime.
