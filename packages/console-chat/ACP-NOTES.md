# ACP SDK Client API — Pinned Reference

**Package:** `@agentclientprotocol/sdk` v0.28.1  
**Pinned from:** `packages/console-chat/node_modules/@agentclientprotocol/sdk/dist/`  
**Protocol version constant:** `PROTOCOL_VERSION = 1` (from `dist/schema/index.d.ts`)  
**Purpose:** Reference for Task 5 (bridge implementation). Do NOT write bridge code from this file alone — see NEEDS LIVE VALIDATION sections.

---

## 1. Client connection entrypoint (non-deprecated)

The old `ClientSideConnection` class is **deprecated** as of 0.28.x. The replacement is the `client()` factory function from the main entry point:

```ts
import { client } from '@agentclientprotocol/sdk';
// main entry: dist/acp.d.ts (re-exports from dist/acp.js)
```

Pattern:

```ts
const app = client({name: 'agentback-console'});

// register handlers BEFORE connecting
app.onNotification('session/update', ({params}) => { /* params: SessionNotification */ });
app.onRequest('session/request_permission', async ({params}) => {
  /* params: RequestPermissionRequest */
  return {outcome: {outcome: 'selected', optionId: params.options[0].optionId}};
});

// connect to a transport stream and run the session workflow
await app.connectWith(stream, async (ctx: ClientContext) => {
  const session = await ctx.buildSession('/absolute/cwd')
    .withMcpServer({type: 'http', name: 'my-mcp', url: 'http://localhost:3000/mcp', headers: []})
    .start();
  await session.prompt('Hello');
  const msg = await session.nextUpdate(); // ActiveSessionMessage
  session.dispose();
});
```

Source: `dist/acp.d.ts` lines 606–669.

### ClientApp API surface

```ts
declare function client(options?: AppOptions): ClientApp;

class ClientApp {
  connect(stream: Stream): ClientConnection;
  connect(agent: AgentApp): ClientConnection;              // in-process, tests only
  connectWith<T>(stream: Stream, op: (ctx: ClientContext) => MaybePromise<T>): Promise<T>;
  connectWith<T>(agent: AgentApp, op: ...): Promise<T>;   // in-process
  onConnect(handler: ClientConnectHandler): this;
  onRequest<Method extends ClientRequestMethod>(method: Method, handler: ...): this;
  onNotification<Method extends ClientNotificationMethod>(method: Method, handler: ...): this;
}

type AppOptions = { name?: string };
```

`connectWith` is the idiomatic entry; `connect` is for long-lived connections.

---

## 2. Attaching to a subprocess stdio (ndJsonStream)

ACP communicates over **newline-delimited JSON** on stdio. The helper:

```ts
import { ndJsonStream } from '@agentclientprotocol/sdk';
// dist/stream.d.ts

declare function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>
): Stream;
```

`Stream` is:

```ts
type Stream = {
  writable: WritableStream<AnyMessage>;
  readable: ReadableStream<AnyMessage>;
};
```

To attach to a Node `child_process` subprocess:

```ts
import {spawn} from 'node:child_process';
// Node ReadableStream / WritableStream → Web Streams conversion needed.
// See NEEDS LIVE VALIDATION below.
```

Source: `dist/stream.d.ts`.

### Alternative: HTTP transport (experimental)

```ts
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client';
// dist/http-stream.d.ts

declare function createHttpStream(
  serverUrl: string,
  options?: HttpStreamOptions
): Stream;

interface HttpStreamOptions {
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  cookies?: 'include' | 'omit';
  cookieStore?: AcpCookieStore;
}
```

Uses POST + SSE GET streams. Exports tagged as `experimental/http-client` in package.json.

### Alternative: WebSocket transport (experimental)

```ts
import { createWebSocketStream } from '@agentclientprotocol/sdk/experimental/ws-client';
// dist/ws-stream.d.ts

declare function createWebSocketStream(
  serverUrl: string,
  options?: WebSocketStreamOptions
): Stream;
```

---

## 3. `initialize` call shape + capability negotiation

`initialize` is **called automatically** by the SDK at connection start when using `connectWith`. It is NOT called manually by the bridge code.

The `InitializeRequest` the SDK sends:

```ts
// dist/schema/types.gen.d.ts line 4015
type InitializeRequest = {
  protocolVersion: ProtocolVersion;         // number, PROTOCOL_VERSION = 1
  clientCapabilities?: ClientCapabilities;
  clientInfo?: Implementation | null;
  _meta?: {[key: string]: unknown} | null;
};

type ClientCapabilities = {
  fs?: FileSystemCapabilities;   // readTextFile/writeTextFile support
  terminal?: boolean;
  plan?: PlanCapabilities | null;           // @experimental
  auth?: AuthCapabilities;                  // @experimental
  elicitation?: ElicitationCapabilities | null;  // @experimental
  nes?: ClientNesCapabilities | null;       // @experimental
  positionEncodings?: Array<PositionEncodingKind>;  // @experimental
  _meta?: {[key: string]: unknown} | null;
};
```

Response from agent:

```ts
// dist/schema/types.gen.d.ts line 1379
type InitializeResponse = {
  protocolVersion: ProtocolVersion;
  agentCapabilities?: AgentCapabilities;
  authMethods?: Array<AuthMethod>;
  agentInfo?: Implementation | null;
  _meta?: {[key: string]: unknown} | null;
};

type AgentCapabilities = {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;   // image/audio/embeddedContext
  mcpCapabilities?: McpCapabilities;         // http/sse/acp transport support
  sessionCapabilities?: SessionCapabilities; // list/delete/fork/resume/close
  auth?: AgentAuthCapabilities;
  providers?: ProvidersCapabilities | null;  // @experimental
  nes?: NesCapabilities | null;              // @experimental
  positionEncoding?: PositionEncodingKind | null; // @experimental
  _meta?: {[key: string]: unknown} | null;
};

type McpCapabilities = {
  http?: boolean;   // McpServerHttp supported
  sse?: boolean;    // McpServerSse supported
  acp?: boolean;    // McpServerAcp supported (@experimental)
};
```

The bridge can inspect `agentCapabilities` from `connection.agent` or via the `ClientContext` after `connectWith` is running. The `SessionBuilder` pattern encapsulates this.

---

## 4. `session/new` — params shape and MCP server config

```ts
// dist/schema/types.gen.d.ts line 4478
type NewSessionRequest = {
  cwd: string;                      // REQUIRED — absolute path
  additionalDirectories?: string[]; // additional workspace roots, absolute paths
  mcpServers: Array<McpServer>;     // list of MCP servers to connect (empty array = none)
  _meta?: {[key: string]: unknown} | null;
};

// McpServer is a discriminated union:
type McpServer =
  | (McpServerHttp & {type: 'http'})   // HTTP transport
  | (McpServerSse & {type: 'sse'})     // Legacy SSE transport
  | (McpServerAcp & {type: 'acp'})     // @experimental: in-band ACP transport
  | McpServerStdio;                     // Stdio transport (no type discriminant)

// HTTP transport (CONFIRMED in McpCapabilities):
type McpServerHttp = {
  name: string;
  url: string;
  headers: Array<HttpHeader>;           // [] for no custom headers
  _meta?: {[key: string]: unknown} | null;
};

// SSE transport (legacy):
type McpServerSse = {
  name: string;
  url: string;
  headers: Array<HttpHeader>;
  _meta?: {[key: string]: unknown} | null;
};

// Stdio transport (no type field — structurally separate):
type McpServerStdio = {
  name: string;
  command: string;                      // path to executable
  args: Array<string>;
  env: Array<EnvVariable>;             // [{name, value}]
  _meta?: {[key: string]: unknown} | null;
};
```

To attach `hello-agent-console`'s `/mcp` HTTP endpoint as an MCP server:

```ts
{type: 'http', name: 'agentback-introspect', url: 'http://localhost:3000/mcp', headers: []}
```

The bridge calls `ctx.buildSession(cwd).withMcpServer(...).start()` — this sends `session/new` internally and returns an `ActiveSession`.

Source: `dist/schema/types.gen.d.ts` lines 4478–4663.

---

## 5. `session/prompt` + `session/update` notification stream

### Sending a prompt turn

`ActiveSession.prompt(...)` wraps `session/prompt`:

```ts
class ActiveSession {
  get sessionId(): SessionId;

  // Strings auto-wrapped as [{type:'text', text: '...'}]
  prompt(prompt: string | ContentBlock | Array<ContentBlock>): Promise<PromptResponse>;

  // Read next update OR stop message
  nextUpdate(): Promise<ActiveSessionMessage>;

  // Convenience: reads only text chunks until stop
  readText(): Promise<string>;

  dispose(): void;
  [Symbol.dispose](): void;
}
```

Raw `session/prompt` params (used by `ActiveSession` internally):

```ts
// dist/schema/types.gen.d.ts line 4926
type PromptRequest = {
  sessionId: SessionId;
  prompt: Array<ContentBlock>;          // [{type:'text', text: 'Hello'}]
  _meta?: {[key: string]: unknown} | null;
};

type PromptResponse = {
  stopReason: StopReason;               // see below
  usage?: Usage | null;                 // @experimental
  _meta?: {[key: string]: unknown} | null;
};

type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
```

### `ActiveSessionMessage` — the discriminated union for `nextUpdate()`

```ts
// dist/acp.d.ts lines 194–220
type ActiveSessionMessage =
  | {
      kind: 'session_update';
      notification: SessionNotification;
      update: SessionUpdate;             // convenience alias
    }
  | {
      kind: 'stop';
      response: PromptResponse;
      stopReason: StopReason;            // convenience alias
    };
```

### `SessionUpdate` — full discriminated union

```ts
// dist/schema/types.gen.d.ts line 3379
type SessionUpdate =
  | (ContentChunk & {sessionUpdate: 'user_message_chunk'})
  | (ContentChunk & {sessionUpdate: 'agent_message_chunk'})  // ← text streaming
  | (ContentChunk & {sessionUpdate: 'agent_thought_chunk'})  // ← thinking tokens
  | (ToolCall & {sessionUpdate: 'tool_call'})                // ← new tool call
  | (ToolCallUpdate & {sessionUpdate: 'tool_call_update'})   // ← tool progress
  | (Plan & {sessionUpdate: 'plan'})
  | (PlanUpdate & {sessionUpdate: 'plan_update'})            // @experimental
  | (PlanRemoved & {sessionUpdate: 'plan_removed'})          // @experimental
  | (AvailableCommandsUpdate & {sessionUpdate: 'available_commands_update'})
  | (CurrentModeUpdate & {sessionUpdate: 'current_mode_update'})
  | (ConfigOptionUpdate & {sessionUpdate: 'config_option_update'})
  | (SessionInfoUpdate & {sessionUpdate: 'session_info_update'})
  | (UsageUpdate & {sessionUpdate: 'usage_update'});

// Text delta is in ContentChunk.content, typed as ContentBlock:
type ContentChunk = {
  content: ContentBlock;    // {type:'text', text: '<delta>'} for agent_message_chunk
  messageId?: MessageId | null;
  _meta?: {[key: string]: unknown} | null;
};

// Notification wrapper:
type SessionNotification = {
  sessionId: SessionId;
  update: SessionUpdate;
  _meta?: {[key: string]: unknown} | null;
};
```

The bridge subscribes to `session/update` via `app.onNotification('session/update', handler)` — the `ActiveSession` routes these automatically when using `nextUpdate()`.

---

## 6. `session/request_permission` — request shape + response

This is a **request from the agent to the client** (server-to-client JSON-RPC request):

```ts
// dist/schema/types.gen.d.ts lines 108–131
type RequestPermissionRequest = {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;             // tool being authorized
  options: Array<PermissionOption>;     // choices to show the user
  _meta?: {[key: string]: unknown} | null;
};

type PermissionOption = {
  optionId: PermissionOptionId;         // opaque string ID
  name: string;                         // human-readable label e.g. "Allow once"
  kind: PermissionOptionKind;
  _meta?: {[key: string]: unknown} | null;
};

type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
```

Response from client:

```ts
type RequestPermissionResponse = {
  outcome: RequestPermissionOutcome;
  _meta?: {[key: string]: unknown} | null;
};

type RequestPermissionOutcome =
  | {outcome: 'cancelled'}                              // user cancelled the prompt turn
  | (SelectedPermissionOutcome & {outcome: 'selected'});

type SelectedPermissionOutcome = {
  optionId: PermissionOptionId;   // must match one of request.options[].optionId
  _meta?: {[key: string]: unknown} | null;
};
```

**No "always allow" scope at the protocol level** — the scope is communicated via the `kind` field on the `PermissionOption` the agent provides. The client echoes back `optionId` of the user's chosen option; the agent sees the `kind` and acts accordingly. There is no separate structured field for "allow always globally" in the response — it's encoded in which option the user picked.

Registering the handler:

```ts
app.onRequest('session/request_permission', async ({params}) => {
  const choice = await askUser(params.toolCall, params.options);
  return {outcome: {outcome: 'selected', optionId: choice.optionId}};
  // or: return {outcome: {outcome: 'cancelled'}} if user canceled
});
```

Source: `dist/schema/types.gen.d.ts` lines 108–131, 591–624, 5399–5441.

---

## 7. Cancellation

Cancel is a **client → agent notification** (not a request — no response):

```ts
// via ClientContext or ClientSideConnection (legacy)
ctx.notify('session/cancel', {sessionId, _meta?: {...}});
// or via methods.agent.session.cancel = 'session/cancel'
```

The `ActiveSession` does not expose a `cancel()` helper directly — cancellation must be sent as a raw notification via `ClientContext`. When received, the agent stops the LLM, sends remaining updates, and responds to the pending `session/prompt` with `stopReason: 'cancelled'`.

---

## 8. Version evolution notes (0.4.x → 0.28.x)

Discernible from the deprecation markers in the types:

- **`ClientSideConnection`** and **`AgentSideConnection`** classes are `@deprecated` in 0.28.x. The replacement is the `client()` / `agent()` factory functions + `connectWith`.
- The new API uses `ClientApp.connectWith(stream, async (ctx) => ...)` instead of constructing a class with callbacks.
- `SessionBuilder` + `ActiveSession` are **new in the 0.28.x API** — they did not exist in the old callback pattern.
- `PROTOCOL_VERSION = 1` is stable (number, not a string).
- The old `extMethod` / `extNotification` on `ClientSideConnection` are deprecated; use `app.onRequest(method, parser, handler)` for custom extension methods.

---

## 9. NEEDS LIVE VALIDATION

The following cannot be confirmed from types alone and must be tested against the real `claude-agent-acp` adapter:

### 9a. Node stdio → Web Streams bridging

`ndJsonStream` takes `WritableStream<Uint8Array>` / `ReadableStream<Uint8Array>` (Web Streams API). Node's `child_process` spawns produce Node.js `Readable` / `Writable` (not Web Streams). The types don't show a Node-specific shim — conversion via `Readable.toWeb()` / `Writable.toWeb()` (Node 18+) or via `@agentclientprotocol/sdk/experimental/node` may be needed.

The `experimental/node` export (`dist/node-adapter.d.ts`) only exposes `createNodeHttpHandler` and `createNodeWebSocketUpgradeHandler` (server-side helpers, not a client stdio adapter). There is no typed `nodeStdioStream` factory visible in the exports.

**Validate:** spawn `claude-agent-acp`, pipe its stdio, confirm whether `Readable.toWeb()` works or whether a custom shim is required.

### 9b. Transport advertised by `claude-agent-acp`

The `McpCapabilities` type shows `http`, `sse`, `acp` options. The `McpServerStdio` type exists (no type discriminant). Whether the real `claude-agent-acp` adapter for AgentBack's Streamable HTTP MCP endpoint prefers `http` vs `sse` transport is not determinable from the SDK types.

**Validate:** send `session/new` with `{type: 'http', ...}` and confirm the agent connects; also confirm whether `sse` is needed as a fallback.

### 9c. `session/new` `cwd` requirement vs. agentback console context

The protocol requires `cwd` to be an absolute path. For a browser-side console, the "working directory" is a logical concept (not a filesystem path). Whether `claude-agent-acp` accepts a placeholder path (e.g., the project root) needs confirmation.

**Validate:** try `cwd: process.cwd()` from the console-chat server process; confirm the agent accepts it.

### 9d. `agentCapabilities.loadSession` and session resumption

The HTTP and WebSocket reconnect docs in the SDK mention calling `session/load` to resume after a disconnected transport. Whether `claude-agent-acp` advertises `loadSession: true` and whether the AgentBack bridge needs session persistence is unconfirmed.

**Validate:** inspect `InitializeResponse.agentCapabilities.loadSession` from a live connection.

### 9e. Permission UI "always allow" scoping

The types show `PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'`. Whether `claude-agent-acp` actually sends all four kinds, or only a subset, and whether an "allow_always" optionId is stable enough for the UI to remember — these are behavioural questions not answerable from types.

**Validate:** trigger a file-edit prompt from a real session and inspect `params.options`.

---

## Quick reference — imports for Task 5

```ts
// Main entry — all stable client-side types and functions
import {
  client,
  ClientApp,
  ClientContext,
  ClientConnection,
  ActiveSession,
  ActiveSessionMessage,
  SessionBuilder,
  ndJsonStream,
  methods,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

// Schema types (re-exported from main entry via `export type *`)
import type {
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  McpServer, McpServerHttp, McpServerStdio,
  SessionNotification,
  SessionUpdate,
  ContentChunk,
  ContentBlock,
  ToolCall, ToolCallUpdate,
  PromptRequest, PromptResponse,
  StopReason,
  RequestPermissionRequest, RequestPermissionResponse,
  RequestPermissionOutcome,
  PermissionOption, PermissionOptionKind,
} from '@agentclientprotocol/sdk';

// HTTP transport (experimental subpath)
import { createHttpStream } from '@agentclientprotocol/sdk/experimental/http-client';
```

## 10. LIVE VALIDATION RESULTS (2026-06-20, claude-agent-acp 0.48, real Claude auth)

Drove the BUILT `AcpSession` against the installed `@agentclientprotocol/claude-agent-acp@0.48.0` + a running `hello-agent-console` `/mcp`.

- **§9a stdio bridging — VALIDATED.** `connect()` (spawn + `ndJsonStream` + `initialize`) works against the real adapter.
- **§9b http MCP transport — VALIDATED.** `session/new` accepted `{type:'http', url:.../mcp}`; the agent actually called `mcp__agentback-app__inventory` and read the live 29 schema entities. Grounding works end-to-end.
- **§9c cwd — VALIDATED.** `process.cwd()`/explicit cwd accepted.
- **§5 OKF-as-first-prompt — works** (no spurious early stop observed; the grounding-drain gate holds).
- **§9e permission flow — FINDING (must-fix for the security model).** With NO permission mode set on the session, claude-agent-acp's DEFAULT mode AUTO-ACCEPTS file edits: a `Write` executed and the file was created WITHOUT any `session/request_permission` reaching our client handler. So the dock's "inline permission card gates edits" is BYPASSED by default. The adapter DOES support prompting — it exposes `permissionMode` / `SessionModeState` / `setSessionMode` / `resolvePermissionMode` (acp-agent.d.ts:162-163, 322). FIX: the bridge must set a prompting permission mode on `session/new` (or via `setSessionMode`) so `session/request_permission` is routed to us; otherwise document honestly that edits are NOT gated by the dock and rely on a trusted/sandboxed workspace + the agent's own permission policy. Until fixed, the security guide's "permission prompts are user-decided / not bypassable" is FALSE for this adapter's default mode.

**§9e is now VALIDATED (2026-06-20, post permission-mode fix).** After the bridge was updated to call `session/set_mode` with `modeId: 'default'` after `session/new` (see `acp-session.ts` `_enforcePermissionMode`), the `default` permission mode causes `claude-agent-acp` to route ALL file edits and shell commands through `session/request_permission`. Live-validated option kinds seen: `allow_always`, `allow_once`, `reject_once`. A client deny (returning `{outcome: 'selected', optionId: <reject_once id>}`) **BLOCKS** the write — the file was NOT created, and the agent's subsequent bash workaround was also gated and blocked. The dock permission card is a real gate when the bridge forces `default` mode. The "allow_always" option is path+session-scoped (the agent tracks it per session; there is no blanket persistent grant).
