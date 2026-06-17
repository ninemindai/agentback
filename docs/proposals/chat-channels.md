# Proposal: `@agentback/chat` — chat platforms as a third inbound surface

**Status:** draft / design sketch
**Backing library:** [Vercel Chat SDK](https://github.com/vercel/chat) (`npm i chat`) — public beta
**Relationship to prior art:** the concrete realization of the "borrow the Channel port" idea from the Eve evaluation. Eve's `channels/` are coupled to Eve's runtime; Chat SDK is the same capability extracted as a standalone, framework-agnostic library — so it can sit behind an AgentBack port with no runtime lock-in.

## Thesis

AgentBack already exposes **two inbound surfaces over one DI container**: REST (humans/programs) and MCP (agents). Chat platforms — Slack, Teams, Discord, Google Chat, Telegram, WhatsApp, GitHub, Linear — are a natural **third inbound surface class**. The same `@agentback/*` services, Drizzle clients, and `@tool` business logic should answer a Slack mention exactly as they answer a REST request or an MCP `tools/call`.

Vercel's Chat SDK is a *transport-only* library: it normalizes per-platform webhooks and outbound posting (`post()` accepts an AI SDK text stream) behind one adapter API. It has **no DI, no config/secrets management, no lifecycle, no service container** — which is precisely the layer AgentBack supplies for everything else. They are complementary the way `@modelcontextprotocol/sdk` + `@agentback/mcp-http` are.

## The boundary that must stay explicit

**AgentBack ships the plumbing, not the brain.** Chat SDK delivers "a message arrived" and lets you `post()` a reply. It does **not** generate the reply — that comes from an agent loop, which AgentBack does not run. So `@agentback/chat` provides:

- inbound webhook mounting (on the RestServer's Express, or fetch-native host) + signature verification
- credential/config wiring via `@agentback/config`
- DI-resolved, lifecycle-managed handler instances (a handler can `@inject` your services)
- a stable `ChatBot`/`ChatThread` **port** that insulates callers from Chat SDK's beta churn

…and it leaves the `post(...)` body to the handler — where the user plugs in `streamText` (AI SDK), a deterministic `@tool`/MCP call, or a remote agent. Say this plainly in the README so nobody expects a turnkey chatbot.

## Shape (mirrors `@agentback/mcp` + `@agentback/mcp-http`)

```
@agentback/chat              (optional package — never a core dep, like files-s3 / messaging-bullmq)
  src/
    keys.ts                  ChatBindings.SERVER, CHAT_HANDLERS extension point
    decorators/chat-bot.ts   @chatBot() = @injectable({scope: SINGLETON}, extensionFor(CHAT_HANDLERS))
    chat.server.ts           ChatServer: collect handlers, build the Chat instance, expose mount
    chat.component.ts        ChatComponent: contributes ChatServer
    install.ts               installChat(app, options): mount on Express + wire onStop
    port.ts                  ChatThread / ChatBot port types (insulation layer)
```

### Extension point + decorator (parallel to `MCP_SERVERS` / `@mcpServer`)

```ts
// keys.ts
export namespace ChatBindings {
  export const SERVER = BindingKey.create<ChatServer>('servers.ChatServer');
}
export const CHAT_HANDLERS = 'chat.handlers'; // extension point name

// decorators/chat-bot.ts — a chat handler IS a DI singleton that extends the CHAT_HANDLERS point
export function chatBot(spec?: ChatBotSpec): ClassDecorator {
  return injectable({scope: BindingScope.SINGLETON}, extensionFor(CHAT_HANDLERS), ...);
}
```

A handler class, discovered the AgentBack way and able to inject services:

```ts
@chatBot()
export class SupportBot {
  constructor(
    @inject('datasources.db') private db: DrizzleClient,
    @inject(MCPBindings.SERVER) private tools: MCPServer, // optional: call existing @tool logic
  ) {}

  // Registered with Chat SDK by ChatServer at start(). Boundary: WE supply the
  // handler wiring; the user supplies what post() streams (AI SDK / tool call).
  onMention = async (thread: ChatThread) => {
    const tickets = await this.db.query.tickets.findMany(/* ... */);
    await thread.post(/* AI SDK stream, or a deterministic tool result */);
  };
}
```

### ChatServer (parallel to `MCPServer` discovery via `extensionFilter`)

```ts
export class ChatServer {
  constructor(@inject.context() private ctx: Context) {}

  // Collect @chatBot instances the same way MCPServer collects @mcpServer classes:
  //   ctx.find(extensionFilter(CHAT_HANDLERS)) -> resolve each through its own
  //   binding (so constructor @inject works), then register with the Chat instance.
  async build(adapters: ChatAdapters): Promise<MountHandle> { /* ... */ }
}
```

### Install (parallel to `installMcpHttp`)

```ts
export async function installChat(app: RestApplication, options: ChatOptions) {
  const chat = await app.get(ChatBindings.SERVER);
  const server = await app.restServer;
  const handle = await chat.mount(server, options);   // Express mount or fetch-native
  app.onStop(() => handle.closeAll());                 // graceful shutdown, like mcp-http
  // (optionally contribute an AX section to /llms.txt advertising the chat surface)
}
```

Call site is identical in spirit to the MCP one:

```ts
const app = new RestApplication();
app.component(ChatComponent);
app.service(SupportBot);          // @chatBot class — a service, like @mcpServer
await installChat(app, {adapters: {slack: slackAdapter()}});
await app.start();                // -> POST /api/chat/slack (webhook)
```

## Config & secrets

Chat SDK auto-detects credentials from env (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, …). Layer `@agentback/config` on top so credentials are **Zod-validated, env-aware, and overlay-able** like the rest of the app — fail fast at boot on a missing/malformed token rather than on the first webhook. Per-platform deps (Slack SDK, etc.) live in the adapter packages and are pulled only when an adapter is enabled.

## Spike validation (2026-06-17) — RESOLVED

Built an isolated, runnable spike (`spike/hello-chat`, plain `npm install`, **published** `@agentback/*` v0.4.0 + `chat`/`@chat-adapter/telegram` v4.31.0 — deliberately not added to the pnpm workspace) that mounts a real `Chat` instance on a real `RestApplication` and drives a synthetic Telegram webhook. All three seam facts passed:

- **MOUNT** — `chat.webhooks.telegram(request)` served `HTTP 200` through the RestServer's Express.
- **DI** — the handler, resolved through the container, reached an `@injectable` `GreetingService` via constructor `@service(...)` injection (captured reply proves it).
- **LIFECYCLE** — `app.onStop(() => chat.shutdown())` ran cleanly on `app.stop()`.

Confirmed facts that close the earlier open question:

- **Chat SDK is Web-standard fetch-native.** The handler is `chat.webhooks.<adapter>(request: Request, options?: WebhookOptions): Promise<Response>`; the `Adapter` interface is `handleWebhook(request: Request): Promise<Response>`. `WebhookOptions.waitUntil(p)` defers background turn processing (maps to Vercel `after()`). So `ChatServer.mount` reuses the **fetch-native** path — and `mcp-http` already branches `server.listener === 'native'` → `mountMcpHttpFetch` vs Express, so the dual-path approach carries over directly.
- **RAW-BODY REQUIREMENT (important) — confirmed + fixed.** AgentBack's default JSON body parser consumes the request stream before a route runs. Telegram (a `x-telegram-bot-api-secret-token` **header** compare) is unaffected, but Slack HMACs the **raw bytes** (`v0:${ts}:${rawBody}`, 5-min skew), so re-serializing `req.body` fails verification. **Fix validated:** configure the server's JSON parser with a `verify` hook that stashes the exact buffer — `new RestApplication({rest: {bodyParser: {json: {verify: (req,_res,buf) => {req.rawBody = buf}}}}})` — and feed `req.rawBody` to the Web Request. AgentBack forwards `bodyParser.json` options straight to `express.json(...)`, so this works today; `@agentback/chat` will set it up automatically. The spike's **second round added Slack** and proved: signed `app_mention` → `200` + handler reached DI; **bad signature → `401`** (negative control); Telegram still `200`. One `Chat` instance served both adapters.
- **No network on the happy path.** In `mode: "webhook"` the Telegram adapter does not poll or call `setWebhook` on init; its `getMe` identity probe is wrapped in try/catch (a bad token only warns). So the seam is testable with a dummy token and no live bot/tunnel — good for `createTestApp`-based tests in the real package.

The spike is throwaway (kept under `spike/`, gitignored — not a workspace member). The "package" step ports the validated bridge into `@agentback/chat`.

## Caveats, ranked

1. **Chat SDK is public beta** ("subject to change") — contain the churn behind the `ChatBot`/`ChatThread` port; never leak Chat SDK types into user-facing signatures. Same insulation discipline as `FileStore` / `PaymentRail` / `JobQueue`.
2. **Don't over-build before validating the seam.** Ship one adapter (Slack) + one example (`examples/hello-chat`: a mention → calls an existing `@tool`/Drizzle service → `post()`s the result). Prove the DI/lifecycle/webhook wiring against a real platform before generalizing the surface.
3. **Keep it opt-in** — out of core and out of the default `create-agentback` templates; offer as an add-on / `--template chat`, mirroring the other capability packages.

## Recommendation

Proceed in two steps:

1. **Spike** — `examples/hello-chat` Slack bot mounting Chat SDK on the RestServer's Express, calling one existing service/tool. Confirms the handler signature and the DI/lifecycle/webhook seam.
2. **Package** — extract the validated seam into `@agentback/chat` (extension point + `@chatBot` + `ChatServer` + `installChat`), behind the insulating port.

Ship the **transport + DI + config + lifecycle + port**; leave the **agent loop** to the handler.

## Implementation status (2026-06-17) — v1 SHIPPED

`@agentback/chat` landed (lockstep v0.4.0), built + tested green (5 tests; full suite 2274 pass), eslint/prettier clean, wired into the root `tsconfig` references.

- **Port-based, zero chat-SDK dep.** The package is structurally typed against a `ChatLike` port (`src/port.ts`), so the public-beta Chat SDK never enters the workspace lockfile — its churn is insulated to one file. A consumer passes their real `new Chat({adapters})`.
- **Discovery mirrors `@agentback/mcp`.** `@chatBot()` = `@injectable({SINGLETON})` + `extensionFor(CHAT_HANDLERS)`; `ChatServer` discovers via `find(extensionFilter(CHAT_HANDLERS))` and resolves each handler through its own binding (constructor `@inject` honored). Method decorators: `@onMention/@onMessage/@onDirectMessage/@onAction/@onReaction/@onSlashCommand` (+ generic `onChatEvent`).
- **Mount mirrors `installMcpHttp`.** `installChat(app, {chat})` mounts `chat.webhooks.<adapter>` per adapter at `<basePath>/<adapter>` via a fetch-native bridge and wires `app.onStop(() => chat.shutdown())`.
- **Raw body fix baked in.** `chatJsonVerify` (an `express.json({verify})` hook) is exported; the bridge forwards `req.rawBody` verbatim (Slack/Teams HMAC), warns once if absent. Covered by an exact-bytes round-trip test.
- **Config decision implemented (hybrid, optional).** Secrets stay in env (adapters auto-detect). Non-secret structure (`basePath`, per-adapter `paths`) is an optional `ChatBindings.CONFIG` binding that `@agentback/config` can populate; `installChat` merges it (explicit options win). Covered by a config-merge test.
- **Adapters are documentation, not code.** The package is adapter-agnostic; README documents `@chat-adapter/{slack,discord,telegram,teams,whatsapp,linear}` + state stores. **Deferred:** an in-repo `examples/hello-chat` (would pull the beta `chat` dep into CI) — the gitignored `spike/hello-chat` remains the runnable end-to-end demo (Telegram + Slack, real adapters).
