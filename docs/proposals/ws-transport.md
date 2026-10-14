# Proposal E-8: WebSocket transport — the APIs you already wrote, over one socket

**Status:** **Design. Not scheduled.** Build this when an app needs it. No
consumer waits on it today (see §1.2). Filed 2026-10-14 for
[#62](https://github.com/ninemindai/agentback/issues/62).

**Packages touched:** new `@agentback/ws`; `@agentback/rest` (the Origin and
scope helpers move here); `@agentback/mcp-http` (imports them).

**Related:** [#60](https://github.com/ninemindai/agentback/issues/60) and
`RestServer.upgrade()` (the raw hook, shipped in 0.13.0);
[P0-2 typed streaming](p0-2-typed-streaming.md);
[MCP 2026 stateless](mcp-2026-stateless.md) (the Origin policy);
[E-7 MCP Events](mcp-events.md); [revertible installs](revertible-installs.md).

---

## Terms

This document uses each term for one thing only.

| Term                        | Meaning                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- |
| **upgrade**                 | The HTTP request that asks to switch to WebSocket, and the `101` reply.                 |
| **connection**              | One open WebSocket after the upgrade.                                                   |
| **carried route**           | An `@api` route that a connection can call.                                             |
| **carried tool**            | A `@tool` that a connection can call.                                                   |
| **call**                    | One JSON-RPC request from the client: `http.request` or `tool.call`.                    |
| **server request**          | One JSON-RPC request from the server to the client, sent with `WsConnection.request()`. |
| **pinned request identity** | The identity headers and remote address of the upgrade, copied onto every call (§3.3).  |
| **gate**                    | The optional authentication check on the upgrade.                                       |

## 1. Motivation

### 1.1 What this adds

`RestServer.upgrade(path, handler)` gives an app a raw WebSocket on its own port.
After the upgrade, the app owns everything. No schema, authentication strategy,
`@authorize`, metering or error envelope applies.

This proposal adds a **transport**, not a new programming model. A connection
carries the `@api` routes and `@tool`s that the app already has. A route call
goes through the same pipeline as HTTP. A tool call goes through
`MCPServer.callTool`, the path that `@agentback/agents` and `@agentback/command`
use. The controllers do not change.
The OpenAPI document stays the contract.

WebSocket is useful only where SSE cannot do the job:

1. **Many calls on one connection**, with low latency and no new request per call.
2. **Server requests.** The server calls the client, for example a host that
   connected out through a firewall.
3. **Calls in both directions on one connection**, for example chat or presence.

A request that returns a stream stays on `streamOf` SSE. SSE already has typed
items, backpressure and resumption.

### 1.2 What this does not change: #60

The app that asked for #60 runs its own JSON-RPC protocol on the raw
`upgrade()` hook. It will not move to this transport. This proposal **never
changes `upgrade()`**. It builds on top of it in a separate package.

That link is still useful evidence. It is bidirectional JSON-RPC 2.0. Most
requests go from the server to the client, and both sides send notifications.
Each side matches replies only against its own pending table. This design uses
the same rules, so a similar app could move to it later. No app has to.

### 1.3 Prior art

[#62](https://github.com/ninemindai/agentback/issues/62) has the survey table
(read 2026-09-29). The findings that set this design:

- **NestJS** guards do not run on connect
  ([#882](https://github.com/nestjs/nest/issues/882)). Here, authentication runs
  on the upgrade and again on every call.
- **Elysia** sends invalid messages past `onError`
  ([#1256](https://github.com/elysiajs/elysia/issues/1256)). Here, every
  failure gets a reply or a close code.
- **`@fastify/websocket`** drops messages if handlers attach late. Here, the
  framework attaches the handlers before it completes the upgrade.
- **Hono** and **crossws** treat the upgrade as a normal request. Here,
  routing, Origin and authentication run before `101`.
- **tRPC** and **graphql-ws** use one connection for many calls, with
  correlated ids. Here, JSON-RPC 2.0 does that.
- **MCP has no WebSocket transport.** SEP-1287 closed unmerged on 2025-12-03,
  and SEP-1288 closed as dormant on 2026-06-26. This transport is not MCP. It
  takes MCP method names only where the meaning is identical.

## 2. Alternatives considered

| Option                                                | Why not                                                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. JSON-RPC bridge to existing APIs** (chosen)      | —                                                                                                                                                                                      |
| B. MCP as an SDK custom transport                     | The spec defines no WebSocket transport. `@api` routes are not MCP, so they would need non-standard methods anyway. It would claim a compliance that does not exist.                   |
| C. `@websocket` + `@message('name', {input, output})` | It is a second source of truth beside `@api` and `@tool`. [agent-ergonomics.md](../agent-ergonomics.md) warns against this. The routes that an app already has would not be reachable. |
| Dispatch every call through `fetchHandler()`          | On the Express host, `fetchHandler()` does not run the Express middleware chain. A connection would skip `installRateLimit` and every `app.middleware()` entry. See §3.4.              |

## 3. Design

### 3.1 Package and install API

The new package is `@agentback/ws`. It depends on `@agentback/rest` and `ws`.
`@agentback/mcp` is an **optional peer**. The package imports it only when the
options carry tools, so a REST-only app does not load the MCP SDK.

```ts
import {installWebSocket} from '@agentback/ws';

const ws = await installWebSocket(app, {
  path: '/ws',
  routes: true, // default: every @api route
  tools: {include: ['forecast']}, // default: no tools
  authenticate: {strategy: 'jwt'}, // optional gate on the upgrade
  onConnect: async (conn, ctx) => {},
  onDisconnect: (conn, reason) => {},
});
await app.start();
```

- Call it **before `app.start()`**. `upgrade()` refuses a path after `start()`.
- It returns `Installed`. `uninstall()` removes the path and closes every
  connection with code `1001`.
- It binds `WsBindings.REGISTRY` at app level (§3.5).
- It passes `runInstallConformance(...)`, like every `install*` helper.

### 3.2 Wire protocol

**Framing.** JSON-RPC 2.0. Each WebSocket **text** frame holds one message. The
protocol has no batches. Either side can send requests and notifications. Each
side matches a response only against its own pending table, so the ids of the
two directions cannot collide.

**Subprotocol.** The client must offer `agentback.jsonrpc.v1`. The version is in
the name, so a later `v2` can run beside it.

**Methods that the client can call:**

| Method                    | Params                                    | Result                                                         |
| ------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| `http.request`            | `{method, path, query?, headers?, body?}` | `{status, headers, body, bodyEncoding?}`                       |
| `tool.call`               | `{name, input}`                           | the output-validated result that `callTool` returns            |
| `tool.list`               | —                                         | `[{name, title?, description?, inputSchema, outputSchema?}]`   |
| `ping`                    | —                                         | `{}` (MCP meaning)                                             |
| `notifications/cancelled` | `{requestId, reason?}`                    | none. It is a notification (MCP meaning). It aborts that call. |

The server can send `notifications/cancelled` and `http.stream` to the client,
plus any method that the app sends with `WsConnection` (§3.5).

**`http.request` keeps HTTP meaning.** A route that answers 404 or 422 gives a
normal JSON-RPC **result** with that `status` and the route's own error body. It
is the same response that HTTP would give. This rule makes parity testable.

- `path` is the full request path, with `basePath`, as over HTTP.
- `body` is JSON. The server sends it as `application/json`.
- A reply body decodes by content type. JSON stays JSON. `text/*` becomes a
  string. Any other type becomes base64 with `bodyEncoding: 'base64'`.
- A `streamOf` route sends one `http.stream` notification for each item,
  `{requestId, data}`. Then it sends the final result `{status, headers}`.
  A stream ends when its connection closes. `resumable:` replay does not apply.

**`tool.call` failures are JSON-RPC errors.** A tool has no HTTP status. A
failure is code `-32000`, and `data` holds the `ErrorEnvelope` from
`buildErrorEnvelope`. A plain `Error` becomes `internal_error`, as on every
other surface.

**The protocol layer uses the standard codes only:** `-32700` parse error,
`-32600` invalid request, `-32601` unknown method, `-32602` invalid params. The
connection stays open after each of these.

```jsonc
→ {"jsonrpc":"2.0","id":1,"method":"http.request","params":{"method":"GET","path":"/greet/Ada"}}
← {"jsonrpc":"2.0","id":1,"result":{"status":200,"headers":{"content-type":"application/json"},"body":{"greeting":"Hello, Ada!"}}}
→ {"jsonrpc":"2.0","id":2,"method":"tool.call","params":{"name":"forecast","input":{}}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Provide a city or coordinates.","data":{"statusCode":400,"code":"invalid_input","message":"Provide a city or coordinates."}}}
```

**A notification from the client needs no new concept.** In JSON-RPC, a request
without an `id` is a notification. If a `tool.call` or `http.request` has no
`id`, the server runs it and sends no reply.

### 3.3 The upgrade, identity and authentication

The server does these steps in this order, all before `101`:

1. **Check `Origin`.** The policy comes from `rest.cors`, as in the stateless
   `/mcp` mount. `deriveOriginAllowlist`, `originAllowed` and
   `corsDeclaredOrigins` move from `@agentback/mcp-http` (`session.ts`) to
   `@agentback/rest`. `mcp-http` then imports them. The precision rules do not
   change. If `Origin` is missing, the check passes, because only browsers send
   it. If `Origin` does not match, the server answers `403`.
2. **Check the subprotocol.** If the client does not offer
   `agentback.jsonrpc.v1`, the server answers `400`.
3. **Check the connection limit** (§3.6). If the server is full, it answers
   `503` with `Retry-After`.
4. **Run the gate**, if the options have `authenticate`. The named strategy
   runs on the upgrade request through a new `fromIncomingMessage` adapter to
   `AuthRequest`. If the gate fails, the server answers `401`. If the options
   have no gate, the connection is anonymous. Each carried route still runs its
   own authentication on every call.

**Pinned request identity.** The server copies these values from the upgrade
once:

- `Authorization`, `Cookie` and `Proxy-Authorization`;
- `Host`, `Forwarded` and every `X-Forwarded-*` header;
- the remote address of the socket.

**Every call gets the pinned request identity.** An `http.request` puts it on
the request that it builds, so the route's own `@authenticate` and the rate
limiter see the same values as over HTTP. A `tool.call` runs the gate strategy
again to get the `principal` that it gives to `callTool`. So, if a token
expires during a connection, the next call fails with 401. The connection stays
open. If the options have no gate, a `tool.call` has no principal. A tool has
no `@authenticate` of its own, so the gate is the only source of a tool
principal.

**A call cannot change the pinned request identity.** If `params.headers` holds
a pinned header, the server answers `-32602`. It does not drop the header
silently. The server also refuses hop-by-hop headers (`Connection`, `Upgrade`,
`Transfer-Encoding`) in `params.headers`. Other headers pass through.

**Browsers cannot set headers on a WebSocket.** The design supports two ways:

- **A cookie.** The browser sends it on the upgrade. The Origin check stops
  cross-site WebSocket hijacking.
- **A bearer token as a second subprotocol**, `bearer.<token>`. The server
  turns it into `Authorization: Bearer <token>`. The server never sends it back
  in `Sec-WebSocket-Protocol`, and never logs it.

Single-use query tickets are out of v1. A call cannot replay a used ticket, so
the per-call authentication rule would fail.

**Contexts.** The connection context is a child of the app context. It binds:

- `WsBindings.CONNECTION`, the `WsConnection` handle (§3.5);
- `CoreBindings.ABORT_SIGNAL`, which aborts when the connection closes;
- `SecurityBindings.USER`, if the gate ran.

Each call has its own signal. That signal aborts when the connection closes or
when the client sends `notifications/cancelled` for that call.

**Liveness.** The server sends a WebSocket ping every 30 s. If a pong does not
arrive before the next ping, the server terminates the connection. The JSON-RPC
`ping` is for the application.

### 3.4 Dispatch and parity

**The parity rule.** A call gets the same response that the same HTTP request
from the same client gets **on this app**. The Express host and the native host
run different pipelines, so dispatch follows the host:

| Host                       | `http.request` runs through                                                                | So these run                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Express listener (default) | [`light-my-request`](https://github.com/fastify/light-my-request) into `server.expressApp` | The full Express chain: CORS, body parsing, `app.middleware()`, `installRateLimit`. Routes that inject raw `req`/`res` work too. |
| Native listener            | `server.fetchHandler().fetch(Request)`                                                     | The same pipeline as HTTP on that host, with `app.webMiddleware()`.                                                              |

The request that the bridge builds carries the pinned request identity. On the
Express host, `light-my-request` sets the **remote address** too, so an
IP-keyed limiter counts a call against the client, not against `127.0.0.1`.

`light-my-request` (6.6.0, BSD-3-Clause) is the base of `fastify.inject`. It is
already in the lockfile. Only `@agentback/ws` depends on it.

**Streams on the Express host.** `light-my-request` returns the response body as
a stream (`payloadAsStream`). The bridge parses SSE or JSONL frames back into
items with the parsers in `@agentback/client` (`sse.ts`, `ndjson.ts`). Phase 1
must measure that a slow reader pauses the producer through this path (§8).

**What a connection carries.**

- `routes` defaults to `true`, every `@api` route. A connection adds no new
  exposure, because each call runs the same authentication and limits as HTTP.
  `routes: false` turns it off.
- `tools` defaults to **none**. An app can serve a tool only over stdio, so the
  app must opt in: `tools: true`, or `tools: {include}`. The selection uses
  `selectTools` from `@agentback/mcp`, the same predicate as `@agentback/agents`
  and `@agentback/command`. So two kinds of tool are **not carried in v1**:
  `confirm:` tools and tools that inject `MCPBindings.ELICIT`. If an include
  list names one, `selectTools` throws at install. See §4.
- **Scope filtering runs on every `tool.call` and every `tool.list`.**
  `@tool({scope})` is a visibility gate, and `callTool` does not check it. The
  bridge works in two steps:
  1. At install, `selectTools({include})` gives the **carried set**. It runs
     with no scopes, so an include entry that names no tool fails at install.
  2. For each call, `selectTools({scopes})` gives the tools that this principal
     can see. The visible tools are the carried set intersected with that
     result. The bridge never passes `include` with `scopes`, because
     `selectTools` throws when an include entry is hidden by scope.

  The rule for `scopes` is the same as in
  `mcp-http` (`index.ts`, `fetch.ts`): if the options have a gate, `scopes` is
  the principal's scopes or `[]`, **never `undefined`**. If the options have no
  gate, `scopes` is `undefined`, and the bridge does not filter. The principal's
  scopes come from the same derivation as `mcp-http` (`defaultScopes` in
  `framework-auth.ts`: the user's `scopes`, else the client application's
  `allowedScopes`). That function moves to a shared place with the Origin
  helpers.

- `tool.call` checks the name against the visible tools **before** it calls
  `callTool`. If the tool is not visible, the reply is an `AgentError` with
  code `not_found`, the same result as an unknown name. Without this check,
  `callTool` throws a plain `Unknown tool` error, and the envelope would redact
  it to a 500.
- The bridge calls `callTool(name, input, {ctx, principal, signal})`, with the
  connection context as `ctx`. So a tool can `@inject(WsBindings.CONNECTION)`.

**Concurrency.** Calls on one connection run at the same time. Replies can come
back in any order. The ids correlate them. §3.6 sets the limit.

### 3.5 Server requests

Each connection has a `WsConnection` handle:

```ts
interface WsConnection {
  readonly id: string;
  readonly principal?: UserProfile; // set if the gate ran
  readonly signal: AbortSignal; // aborts on close
  request<T = unknown>(
    method: string,
    params?: unknown,
    opts?: {signal?: AbortSignal; timeoutMs?: number},
  ): Promise<T>;
  notify(method: string, params?: unknown): void;
  close(code?: number, reason?: string): void;
}
```

- A server request times out after 30 s by default. `timeoutMs` changes it.
- If a server request times out, or its signal aborts, or the connection closes,
  the promise rejects. On a timeout or an abort, the server also sends
  `notifications/cancelled {requestId}` to the client. The server drops a reply
  that comes after this.
- If the client replies with a JSON-RPC error, the promise rejects with a
  `RemoteError {code, message, data}`.

**Typed server requests.** `defineRemoteMethod({method, params, result})` joins
a method name to two Zod schemas. `remote.call(conn, params)` validates the
params before it sends them, which finds bugs in the server. It validates the
result when it arrives, which finds bugs in the client. `request()` and
`notify()` stay available for dynamic cases.

**How app code gets a connection:**

1. **`onConnect(conn, ctx)` and `onDisconnect(conn, reason)`** in the install
   options. Use them for presence and per-connection setup.
2. **`@inject(WsBindings.CONNECTION)`** in a carried tool, because `callTool`
   runs in the connection context. **A route cannot get the connection.** A
   carried route is an HTTP API. A route that needs the connection is not
   transport-neutral, so it must be a tool or an `onConnect` handler.
3. **`WsBindings.REGISTRY`**, with `list()`, `get(id)` and
   `forPrincipal(principalId)`. A service or a job uses it to send to the
   connections of one user or one host. The registry holds the connections of
   this process only, the same limit as resumable SSE.

### 3.6 Errors, limits and backpressure

**No error escapes a message handler.** A throw from a `'message'` listener
stops the process. Each dispatch therefore runs inside a try/catch, as the
`'upgrade'` listener of `upgrade()` does.

| Event                                                 | Result                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------- |
| The frame is not valid JSON                           | Reply `-32700` with `id: null`. The connection stays open. |
| The frame is binary                                   | Close `1003`.                                              |
| The frame is larger than `maxPayload` (default 1 MiB) | Close `1009`. `ws` enforces this limit.                    |
| `onConnect` throws                                    | Close `1011`. The server logs the error.                   |
| `onDisconnect` throws                                 | The server logs the error.                                 |
| `app.stop()` or `uninstall()`                         | Close `1001`.                                              |

Origin, subprotocol, limit and gate failures happen **before** `101`. They are
HTTP statuses (`403`, `400`, `503`, `401`), never close codes.

**Limits.** Each limit is an install option.

| Option               | Default | When the limit is reached                                                                                                       |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `maxConnections`     | 1000    | The next upgrade gets `503` with `Retry-After`. The server reserves the slot at the check, so parallel upgrades cannot go over. |
| `maxInFlight`        | 32      | The next call on that connection gets `-32000` with status 429 in `data`.                                                       |
| `maxPendingRequests` | 128     | `WsConnection.request()` rejects at once.                                                                                       |

**Backpressure.** Replies and `http.stream` items go through a `StreamSink` that
uses the connection. `StreamSink` is the interface in
`packages/rest/src/resumable-streams.ts`.

- `write()` returns `false` when `bufferedAmount` is more than 1 MiB.
- `drain()` resolves when the `ws.send` callbacks bring it below 1 MiB.
- So a slow reader pauses a `streamOf` producer, as it does over SSE.
- If `bufferedAmount` is more than 16 MiB, the server closes the connection
  with `1008` ("slow consumer"). One stuck client must not hold server memory.

**Logging.** The namespace is `agentback:ws`, through `loggers`. The server
never logs a pinned header, the `bearer.` subprotocol or a message body. A log
line for a call has the method, the id and the connection id only.

## 4. Interaction with other features

- **`confirm:` tools and eliciting tools are not carried in v1.** `selectTools`
  excludes both, because a projected caller cannot do the round trip. A
  connection is different: the client is a live peer, and the server can send
  it a server request. So a later phase can carry both. A `confirm:` tool can
  use the token exchange (`confirmation_required`, then a second call with the
  token). An eliciting tool can send its question as a server request. Both are
  follow-ups (§7). Until then, the raw `upgrade()` hook or `/mcp` serves these
  tools.
- **Carried routes are not affected.** A `confirm:` or `idempotency:` option on
  a **route** runs inside the route pipeline, so an `http.request` gets the same
  behaviour as HTTP.
- **MCP Events (E-7).** `@agentback/mcp-events` delivers events through the
  `EventDelivery` port. `WebhookEventDelivery` is its only implementation. A
  WebSocket implementation of that port is a follow-up.
- **Metering.** v1 adds nothing. A carried route emits its normal `'rest'`
  event through the REST dispatch hook. A carried tool emits its normal `'mcp'`
  event. A `transport: 'ws'` tag needs a new field on `RestDispatchInfo`. That
  is a follow-up.
- **Plugins.** A plugin that calls `installWebSocket` must do it before
  `app.start()`. The `upgrade()` freeze applies. Registration after start is a
  follow-up for `upgrade()` itself.
- **Edge hosts.** v1 runs on the Node host only. `upgrade()` is Node-only.
  Workers, Bun and Deno are phase 3 (§7).

## 5. Testing

Every integration test uses a real `ws` client. No test mocks the connection.

1. **Parity suite.** Each case sends the same request over HTTP and as
   `http.request`. The test compares status, body and error envelope. The suite
   runs on the Express listener and the native listener, with `describe.each`
   as in `upgrade.integration.ts`. The cases:
   - a GET with path and query parameters, and a POST with a JSON body;
   - a 422 validation failure, and a 404 unknown path;
   - a route that needs authentication, with a token and without one;
   - a 403 from `@authorize`;
   - a rate-limited route: calls count against the same IP as HTTP;
   - a plain `Error`, redacted to `internal_error`;
   - a `streamOf` route: the `http.stream` items equal the SSE items.
2. **Protocol.** Invalid JSON gives `-32700` and the connection stays open. An
   unknown method gives `-32601`. A binary frame closes with `1003`. A large
   frame closes with `1009`. A call without an `id` gets no reply.
   `notifications/cancelled` aborts the signal of that call.
3. **Upgrade and identity.** A failed gate gives `401`, with no `101`. A wrong
   `Origin` gives `403`. A missing subprotocol gives `400`. An `authorization`
   value in `params.headers` gives `-32602`, and the principal does not change.
   The `bearer.<token>` subprotocol authenticates, and the server does not echo
   it. An expired token fails the next call with 401, and the connection stays
   open. With a gate, an anonymous principal cannot call or list a
   `@tool({scope})` tool, and the reply is `not_found`.
4. **Server requests.** `request()` resolves with the reply. A JSON-RPC error
   rejects with `RemoteError`. A timeout sends `notifications/cancelled`. A late
   reply changes nothing. A close rejects every pending request.
   `defineRemoteMethod` rejects a result that does not match its schema.
5. **Limits and lifecycle.** The upgrade after `maxConnections` gets `503` with
   `Retry-After`. Call 33 gets status 429. A slow reader pauses a `streamOf` producer. A reader
   past 16 MiB closes with `1008`. `uninstall()` closes every connection with
   `1001`. `runInstallConformance(...)` passes.
6. **Mutation checks.** Remove each of these guards from `dist/` and confirm
   that a test fails: the rule that a call cannot change the pinned request
   identity, the try/catch around message dispatch, and the scope filter on
   `tool.call`.

## 6. Risks

- **Two dispatch paths can drift.** The Express path uses injection and the
  native path uses `fetchHandler()`. The parity suite runs on both hosts to
  find this drift.
- **Injection overhead.** Each `http.request` on the Express host builds a
  simulated request and response. Phase 1 must measure the cost against a plain
  HTTP request. If it is too high, the fallback is `fetchHandler()` for routes
  that no Express-only middleware touches. That fallback is a parity trade-off,
  so it needs its own decision.
- **Header handling.** The pinned list and the refused list are security
  rules. They are in one module, and the tests cover each header.

## 7. Sequencing

1. **Node host.** `@agentback/ws` with §3 complete, the Origin and scope
   helpers moved to `@agentback/rest`, and the tests in §5.
2. **Typed client.** `@agentback/client` gets a WebSocket transport option, so
   the existing `defineRoute` descriptors work over a connection as well as
   over `fetch`. This phase also emits AsyncAPI 3 for the server requests that
   OpenAPI cannot describe (Zod `toJSONSchema` with `target: 'draft-07'`).
3. **Edge hosts.** A fetch-host path that returns `101`: `WebSocketPair` on
   Workers, the `websocket` option of `Bun.serve`, and `Deno.upgradeWebSocket`.
4. **Rooms.** Topics over an `EventBus` backplane, so `WsBindings.REGISTRY` can
   reach connections in other processes. Event push from `ActorRegistry.subscribe`.
5. **Durable Objects.** WebSocket hibernation in `actors-do`.

**Follow-ups that are not phases:**

- `confirm:` tools and eliciting tools over a connection, with server requests
  for the questions;
- a WebSocket `EventDelivery` for MCP Events;
- a `transport: 'ws'` metering tag;
- registration after `start()` in `upgrade()`.

## 8. Open decisions

- **Backpressure through injection.** Does a `light-my-request` response stream
  pause the route's producer when the bridge stops reading? Phase 1 measures
  this first. If it does not, the Express host buffers stream items up to the
  16 MiB limit, then closes the connection.
- **Where the shared auth helpers live.** The Origin helpers and
  `defaultScopes` leave `@agentback/mcp-http`. The recommendation is
  `@agentback/rest`, because both consumers already depend on it. The
  alternative is `@agentback/common`, but the Origin helpers read `rest.cors`.

## 9. Out of scope

- MCP over WebSocket (the spec defines no such transport).
- Socket.IO protocol compatibility and long-polling fallback.
- Batches, binary frames and multipart request bodies.
- MCP resources and prompts.
- Exactly-once delivery.

The raw `upgrade()` hook stays the escape hatch for all of these.
