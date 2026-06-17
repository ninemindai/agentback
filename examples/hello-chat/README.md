# hello-chat

Chat platforms (Slack, Telegram, …) as a **third inbound surface** over the same
AgentBack DI container that serves REST and MCP — using
[`@agentback/chat`](../../packages/chat).

A `@chatBot` handler (`src/support-bot.ts`) is a DI service: it `@inject`s a
`GreetingService` the same way a REST controller or `@tool` class would. One bot,
many platforms; the reply logic lives in your handler (this example just echoes a
greeting — swap in an AI SDK stream or a tool call).

## Build

```bash
pnpm -F hello-chat build      # from the repo root (after pnpm build)
```

## Try it with Telegram (easiest — no tunnel)

Polling mode talks to Telegram directly, so no public URL is needed:

```bash
# 1. Create a bot with @BotFather, copy the token
# 2. Run the polling entrypoint
TELEGRAM_BOT_TOKEN=123456:ABC... pnpm -F hello-chat start:telegram
# 3. DM your bot — it replies via the DI handler
```

`src/try-telegram.ts` uses the package's `ChatServer.register(chat)` (the
discovery half of `installChat`, without an HTTP mount) and `chat.initialize()`
to start long-polling.

## The canonical setup: webhooks (`src/index.ts`)

This is what `@agentback/chat` is really for — `installChat` mounts each
adapter's webhook on the RestServer's Express:

```bash
# Terminal A — a public HTTPS tunnel to local port 3000
cloudflared tunnel --url http://localhost:3000

# Terminal B — enable adapters whose credentials are set
TELEGRAM_BOT_TOKEN=... \
SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... \
PORT=3000 pnpm -F hello-chat start
```

It prints the mounted webhook URLs (`POST /api/chat/<adapter>`); point each
platform at `https://<tunnel>/api/chat/<adapter>` (Slack Event Subscriptions,
Telegram `setWebhook`, etc.). `chatJsonVerify` is wired so Slack/Teams signature
verification works behind AgentBack's JSON parser.

## Secrets vs structure

Credentials come from **environment variables** (the adapters auto-detect
`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, …) — never from
files. Non-secret structure (webhook paths, base path) can come from
`@agentback/config` via `ChatBindings.CONFIG`. See the package README.
