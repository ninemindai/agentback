# Proposal E-8: WebSocket transport — your tools and typed server requests, over one socket

**Status:** **Design. Not scheduled.** Filed 2026-10-14 for
[#62](https://github.com/ninemindai/agentback/issues/62) and revised after an
`/autoplan` review (CEO, DX and Eng phases, approved 2026-10-17). No consumer
waits on it today (see §1.2).

**Scope of v1.** Phase 1 carries `@tool`s, typed server requests and the client
(§7). Carrying `@api` routes (`http.request`) is phase 2. The review moved it
there because no consumer needs REST over a socket yet, and because most of the
review's hard findings sit in the route bridge (§3.9). Phase 2 keeps that
hardened design, so nothing in it has to be found again.

**Build trigger.** Phase 1 starts only when a named app owner commits to adopt
it for a stated workflow, for example "a cloud app calls tools on local agent
hosts that connect out through NAT", and says why the raw `upgrade()` hook and
HTTP + SSE are not enough for that workflow. A general request for "WebSocket
support" is not a trigger.

**Kill criterion.** If no app outside this repo uses `@agentback/ws` within
three minor releases after phase 1 ships, the package is marked deprecated.
Use is measured by the usage events in §4: carried tools with
`transport: 'ws'`, and server requests, which emit their own event, so an app
that uses only server requests is counted too. Outside adoption is established
by a public repo, an issue or a user report that names the app.

**Packages touched in phase 1:** new `@agentback/ws`; `@agentback/mcp`
(`CallToolOptions.noLocalPrincipal`, `principalScopes`, and
`createToolRateLimiter`, which moves here from `@agentback/mcp-http`);
`@agentback/mcp-http` (uses the moved limiter and the shared
`principalScopes`); `@agentback/openapi` (a `PAYLOAD_TOO_LARGE` error code);
`@agentback/client` (`createWsClient`, `defineRemoteMethod` and `RemoteError`,
so a browser client can import them); `@agentback/metering` (a `'ws'` usage
surface); `@agentback/testing` (a WebSocket probe and test client). Phase 2
adds `@agentback/rest` changes (§3.9). §3.7 lists every new public API and why
it exists.

**Related:** [#60](https://github.com/ninemindai/agentback/issues/60) and
`RestServer.upgrade()` (the raw hook, shipped in 0.13.0);
[P0-2 typed streaming](p0-2-typed-streaming.md);
[MCP 2026 stateless](mcp-2026-stateless.md) (the `/mcp` Origin policy);
[E-7 MCP Events](mcp-events.md); [revertible installs](revertible-installs.md).

---

## Terms

This document uses each term for one thing only.

| Term                        | Meaning                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **upgrade**                 | The HTTP request that asks to switch to WebSocket, and the `101` reply.                                      |
| **connection**              | One open WebSocket after the upgrade.                                                                        |
| **carried tool**            | A `@tool` that a connection can call.                                                                        |
| **carried route**           | An `@api` route that a connection can call. Phase 2 only (§3.9).                                             |
| **call**                    | One JSON-RPC request from the client: `tool.call` in phase 1, and `http.request` in phase 2.                 |
| **server request**          | One JSON-RPC request from the server to the client, sent with `WsConnection.request()` or `call()`.          |
| **pinned request identity** | The identity headers, `Origin`, the platform client-IP headers and the remote address of the upgrade (§3.3). |
| **gate**                    | The optional authentication check on the upgrade, which runs again before every call (§3.3).                 |
| **client key**              | The key for per-client limits: the principal id after a gate, else the client address (§3.6).                |

## 1. Motivation

### 1.1 What this adds

`RestServer.upgrade(path, handler)` gives an app a raw WebSocket on its own port.
After the upgrade, the app owns everything. No schema, authentication strategy,
`@authorize`, metering or error envelope applies.

This proposal adds a **transport**, not a new programming model. A connection
carries the `@tool`s that the app already has, and lets the server send typed
requests to the connected client. A tool call goes through
`MCPServer.callTool`, the path that `@agentback/agents` and `@agentback/command`
use. The tool classes do not change. In phase 2 a connection also carries the
app's `@api` routes through the same pipeline as HTTP (§3.9).

WebSocket is useful only where SSE and HTTP cannot do the job:

1. **One authenticated connection for calls and server requests.** HTTP/2
   already sends many calls on one connection, so this is not a latency claim.
   The gain is that the connection that carries calls can also carry requests
   from the server.
2. **Server requests.** The server calls the client, for example a host that
   connected out through a firewall.
3. **Calls in both directions on one connection**, for example chat or presence.

For a request that returns a stream, SSE stays the recommended path: it has
typed items, backpressure and resumption. Streaming from the client to the
server is out of scope (§9).

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
  on the upgrade and again before every call.
- **Elysia** sends invalid messages past `onError`
  ([#1256](https://github.com/elysiajs/elysia/issues/1256)). Here, every
  failure gets a reply, a close code or a counted log line (§3.6).
- **`@fastify/websocket`** drops messages if handlers attach late. Here, the
  framework attaches the handlers before it completes the upgrade, and it
  queues messages while `onConnect` runs.
- **Hono** and **crossws** treat the upgrade as a normal request. Here,
  Origin, limits and authentication run before `101`.
- **tRPC** and **graphql-ws** use one connection for many calls, with
  correlated ids. Here, JSON-RPC 2.0 does that.
- **Positioning.** For generic web apps, Hono, Elysia and NestJS already give
  "WebSocket on my framework", and Cloudflare's Agents SDK gives per-agent
  sockets at the edge. AgentBack does not compete on that. Its one advantage is
  that one Zod and DI tool surface is governed the same way on every surface:
  the same `@authorize`, scopes, metering and limits on REST, MCP, the CLI,
  agents and now a socket. The design keeps that rule, and the most valuable
  part is typed server requests to a connected client (§3.5), which no other
  AgentBack surface has.
- **MCP has no WebSocket transport.** SEP-1287 closed unmerged on 2025-12-03,
  and SEP-1288 closed as dormant on 2026-06-26. This transport is not MCP. It
  takes MCP method names only where the meaning is identical.

## 2. Alternatives considered

| Option                                                    | Why not                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. JSON-RPC bridge to existing APIs** (chosen)          | —                                                                                                                                                                                                                                                                                                                      |
| B. MCP as an SDK custom transport                         | The spec defines no WebSocket transport. `@api` routes are not MCP, so they would need non-standard methods anyway. It would claim a compliance that does not exist.                                                                                                                                                   |
| C. `@websocket` + `@message('name', {input, output})`     | It is a second source of truth beside `@api` and `@tool`. [agent-ergonomics.md](../agent-ergonomics.md) warns against this. The routes and tools that an app already has would not be reachable.                                                                                                                       |
| D. A typed JSON-RPC peer on the raw `upgrade()` hook only | The smallest option: `defineRemoteMethod`, pending tables, timeouts, cancellation and limits, with no tool bridge. It serves the one known user's shape. It does not give the governed tool surface, which is the positioning above. The bridge is built **on** this peer, so D is the bottom layer of A, not a rival. |
| SSE down + POST up, with JSON-RPC correlation             | `/mcp` already sends server-to-client requests this way. It is the right answer for MCP's fixed server-request set. It does not fit app-defined server requests at a high rate in both directions, or a platform that allows one socket only. Those cases are why WebSocket exists here.                               |
| Node first vs Durable Objects first                       | DO hibernation gives one owner per identity and no cross-process lookup. Node first is chosen because `upgrade()` exists, the tests run in this repo's CI, and the DO path needs the same protocol anyway. DO stays a roadmap phase, and the registry is a port (§3.5) so the DO adapter does not change the API.      |
| Reuse the `/mcp` Origin helpers                           | They call the MCP SDK's `validateOriginHeader`, and with no `rest.cors` they allow localhost only, so a same-origin page would get `403`. §3.3 defines a separate, stricter policy.                                                                                                                                    |
| Carry `@api` routes in v1                                 | Deferred to phase 2 (§3.9). No consumer needs REST over a socket yet, and the route bridge is where the review found cancellation, backpressure, buffering and cookie problems.                                                                                                                                        |

## 3. Design

### 3.1 Package and install API

The new package is `@agentback/ws`. Its dependencies are `@agentback/rest`,
`@agentback/core`, `@agentback/common`, `@agentback/authentication`,
`@agentback/security`, `@agentback/openapi`, `@agentback/client`, `ws`,
`proxy-addr` and `zod`. `@types/ws` and `@types/proxy-addr` are dev
dependencies. `@agentback/mcp` is an **optional peer**: the package imports it
only when the options carry tools, so an app that uses only server requests
does not load the MCP SDK.

The smallest working form, on the server and in a client:

```ts
import {installWebSocket} from '@agentback/ws';
await installWebSocket(app, {path: '/ws', tools: {include: ['forecast']}});
await app.start();

import {createWsClient} from '@agentback/client';
const c = createWsClient({url: 'ws://localhost:3000/ws'});
await c.connect();
const out = await c.tool('forecast', {city: 'Tokyo'});
```

Then add options one at a time:

```ts
await installWebSocket(app, {
  path: '/ws',
  tools: {include: ['forecast'], rateLimit: {points: 60, durationSecs: 60}},
  strategyAuth: {strategy: 'jwt'},
  allowedOrigins: ['https://app.example.com'],
  onConnect: async (conn, ctx) => {},
  onDisconnect: (conn, reason) => {},
});
```

**Naming rule.** Function names spell out `WebSocket` (`installWebSocket`;
`createWsClient` is the one exception because it pairs with `createClient`).
Types and bindings use the `Ws` prefix (`WsOptions`, `WsConnection`,
`WsBindings`). The package is `@agentback/ws`.

The complete option type:

```ts
interface WsOptions {
  /** Upgrade path. Matched exactly; `basePath` is not applied (§3.3). */
  path: string;
  /**
   * Carry tools. Default: none, so the connection carries only server requests.
   * `true`, and `{rateLimit}` without `include`, select every tool that
   * `selectTools()` selects. `{include: []}` throws at install ("omit `tools`
   * to carry none").
   */
  tools?: true | {include?: string[]; rateLimit?: WsToolRateLimit};
  /**
   * The gate (§3.3). Same shape and strategy-chain behaviour as
   * `installMcpHttp`'s `strategyAuth`; the differences are in §3.3 and §6.
   */
  strategyAuth?: {
    strategy: string | string[];
    options?: Record<string, unknown>; // passed to the strategy, as `@authenticate` does
    required?: boolean; // default true
    /** Principal → MCP scopes. Default: `principalScopes(auth)` (§3.4). */
    scopes?: (auth: AuthenticationResult) => string[];
  };
  /** Exact origins added to the same-origin rule, a predicate, or '*' to turn the check off. */
  allowedOrigins?:
    string[] | ((origin: string, upgrade: IncomingMessage) => boolean) | '*';
  /** Key for per-client limits and the default tool rate-limit key (§3.6). */
  clientKey?: (upgrade: IncomingMessage, principal?: UserProfile) => string;
  /** Extra headers to pin from the upgrade, added to the defaults (§3.3). */
  pinnedHeaders?: string[];
  maxConnections?: number; // default 1000
  maxConnectionsPerClient?: number; // default 16
  maxUpgradesInGatePerAddress?: number; // default 8 [estimated]
  upgradeTimeoutMs?: number; // default 10 s [estimated]
  onConnectTimeoutMs?: number; // default 10 s [estimated]
  maxInFlight?: number; // per connection, default 32
  maxInFlightTotal?: number; // per server, default 4096 [estimated]
  callTimeoutMs?: number; // client calls, default 300 s (Node's requestTimeout)
  maxPendingRequests?: number; // default 128
  maxRequestBytes?: number; // inbound frame bytes, default 1 MiB (passed to ws as maxPayload)
  maxResponseBytes?: number; // default 1 MiB
  backpressure?: {pauseBytes?: number; closeBytes?: number}; // defaults 1 MiB / 16 MiB
  requestTimeoutMs?: number; // server-request default, 30 s
  pingIntervalMs?: number; // default 30 s
  onConnect?: (conn: WsConnection, ctx: Context) => void | Promise<void>;
  onDisconnect?: (
    conn: WsConnection,
    reason: {code: number; reason: string},
  ) => void;
}

/** Declared here, structurally, as the option type of `createToolRateLimiter`. */
interface WsToolRateLimit {
  points?: number; // default 60
  durationSecs?: number; // default 60
  perTool?: Record<
    string,
    {points: number; durationSecs?: number; blockSecs?: number}
  >;
  store?: unknown; // a rate-limiter-flexible store, e.g. Redis, to share a budget with /mcp
  keyPrefix?: string;
  keyGenerator?: (caller: {
    header(name: string): string | undefined;
    ip?: string;
    authInfo?: unknown;
  }) => string;
}
```

- Call it **before `app.start()`**. `upgrade()` refuses a path after `start()`.
- It returns `Installed`. `uninstall()` removes the path and closes every
  connection in the order that §3.6 gives. A second `uninstall()` does nothing.
- The install body uses `installSteps` from `@agentback/common`, so a failure
  part-way rolls back what landed, as every async `install*` helper does.
- It binds `WsBindings.REGISTRY` at app level (§3.5), and `uninstall()` unbinds
  it. **One `installWebSocket` per app in v1**: a second call throws
  "installWebSocket: one per app in v1; uninstall the first or extend its
  options". Several paths with different gates are a follow-up.
- Every install-time error names the item and the fix:
  - an include entry that matches nothing ("tool 'forcast' matches no tool;
    did you mean 'forecast'?");
  - a `confirm:` or eliciting tool ("tool 'pay' uses confirm: and is not
    carried in v1; serve it over /mcp");
  - a priced tool from `@agentback/payments` ("tool 'quote' is priced; a
    socket call has no per-call payment header; serve it over /mcp");
  - an `anonymous` strategy in the `strategyAuth` chain ("a bad credential
    would become anonymous without an error; use required: false instead");
  - an unknown strategy name;
  - `{include: []}`, and a second install.

### 3.2 Wire protocol

**Framing.** JSON-RPC 2.0. Each WebSocket **text** frame holds one message. The
protocol has no batches. Either side can send requests and notifications. Each
side matches a response only against its own pending table, so the ids of the
two directions cannot collide.

**Ids and frame shape.**

- An `id` must be a string or an integer. Any other `id` gets `-32600` with
  `id: null`.
- A call whose `id` matches a call that is still in flight on that connection
  gets `-32600` with `id: null` and `data.duplicateId`, and the first call
  continues. A reply with `id: null` cannot be matched to the first call, so
  the client's pending table never gets two replies for one id.
- A frame that holds a JSON array (a batch) gets `-32600` with `id: null`.
- A frame that has both `method` and `result` (or `error`) gets `-32600`.
- A response frame whose `id` matches no pending server request is dropped and
  counted in `stats().unmatchedResponses`.

**Methods that are off.** Without the `tools` option, `tool.call` and
`tool.list` get `-32601` with `data: {code: 'method_disabled', hint}`, and the
hint names the option to set ("tool.call is off: pass tools: true or tools:
{include: [...]} to installWebSocket"). In phase 1, `http.request` also gets
`method_disabled`, with a hint that names phase 2. An unknown method gets
`-32601` with `data.code: 'method_not_found'`, so a typo and a disabled feature
look different. Without tools, the connection carries only server requests and
notifications, which is the shape of the #60 link.

**Subprotocol.** The client must offer `agentback.jsonrpc.v0`. **The protocol
is experimental**: method names, error codes and the subprotocol may change
before `@agentback/ws` reaches 1.0, and the first stable protocol will be
`agentback.jsonrpc.v1`. The version is in the name, so a later version can run
beside an earlier one. Rules for change:

- A `v0` change ships only in a minor release, with an `agentback update`
  advisory (the existing migration registry) that names what changed.
- When `v1` ships, the server accepts `v0` and `v1` for at least one minor
  release and logs one deprecation warning per `v0` connection that names the
  migration note. `createWsClient` offers both and uses the newest the server
  accepts.

**Naming.** AgentBack methods use dots (`tool.call`, `http.request`). A method
that has exactly the MCP meaning keeps its MCP name (`ping`,
`notifications/cancelled`), so a reader who knows MCP knows what it does.

**If MCP ships a WebSocket transport.** `@agentback/mcp` would serve it like
stdio and HTTP. Apps that use `/ws` only for tools would move to it. `/ws` would
keep the parts MCP does not define: app-defined server requests and, from
phase 2, carried routes.

**Methods that the client can call:**

| Method                    | Params                 | Result                                                         |
| ------------------------- | ---------------------- | -------------------------------------------------------------- |
| `tool.call`               | `{name, input}`        | the output-validated result that `callTool` returns            |
| `tool.list`               | —                      | `[{name, title?, description?, inputSchema, outputSchema?}]`   |
| `ping`                    | —                      | `{}` (MCP meaning)                                             |
| `notifications/cancelled` | `{requestId, reason?}` | none. It is a notification (MCP meaning). It aborts that call. |
| `http.request`            | phase 2 (§3.9)         | phase 2                                                        |

The server can send `notifications/cancelled` to the client, plus any method
that the app sends with `WsConnection` (§3.5). Phase 2 adds `http.stream`.

**`tool.call` results and failures.**

- A streaming `@tool` returns its collected items as an array. Progress is not
  relayed, because the call carries no `progressToken`.
- A failure is code `-32000`, and `data` holds the `ErrorEnvelope` from
  `buildErrorEnvelope` (`statusCode`, `code`, `message`, and the optional
  fields). A plain `Error` becomes `internal_error`, as on every other surface.
- A rate limit (§3.4) uses the `/mcp` code `-32029` with
  `data: {code: 'rate_limited', retryAfterSecs}`.
- A result whose JSON is larger than `maxResponseBytes` is not sent. The reply
  is `-32000` with `data.code: 'payload_too_large'` and `data.statusCode: 413`.
  `ErrorCodes` gets `PAYLOAD_TOO_LARGE`. The bridge sets the code itself, so
  `codeForStatus()` and every HTTP response stay as they are.
- A call that runs past `callTimeoutMs` has its signal aborted and gets
  `-32000` with `data.statusCode: 504`.

**The protocol layer uses the standard codes only:** `-32700` parse error,
`-32600` invalid request, `-32601` unknown method, `-32602` invalid params. The
connection stays open after each of these.

**Every error says what, why and how to fix.** Each protocol error has
`data: {code, hint}` beside the message. The message names the field or
method; the hint names the fix. An invalid param gives `-32602` that names the
param and the expected type.

```jsonc
→ {"jsonrpc":"2.0","id":1,"method":"tool.call","params":{"name":"forecast","input":{"city":"Tokyo"}}}
← {"jsonrpc":"2.0","id":1,"result":{"tempC":18}}
→ {"jsonrpc":"2.0","id":2,"method":"tool.call","params":{"name":"forecast","input":{}}}
← {"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Provide a city or coordinates.","data":{"statusCode":400,"code":"invalid_input","message":"Provide a city or coordinates."}}}
```

**A notification from the client needs no new concept.** In JSON-RPC, a request
without an `id` is a notification. If a `tool.call` has no `id`, the server runs
it and sends nothing back. A notification counts against `maxInFlight` (§3.6),
and over the limit it is dropped. So a notification is lossy: use it only where
a lost message does not matter. `notifications/cancelled` and `ping` never
count, so a full connection can still cancel a call and check that it is alive.

**The order of checks for each message.** The server takes these steps in this
order. The first step that fails decides the reply.

1. The frame is text, is valid JSON, is not an array, has a valid shape and a
   valid `id` (§3.2, §3.6).
2. The method exists and is on (`-32601`).
3. `maxInFlight` and `maxInFlightTotal`, except for `notifications/cancelled`
   and `ping` (§3.6).
4. The gate re-run, except for `notifications/cancelled` and `ping` (§3.3).
5. The params are valid (`-32602`).
6. For `tool.call`: visibility (`not_found`), then the tool rate limit
   (`-32029`). A name that is not visible costs no rate-limit point, so random
   names cannot grow the limiter's memory.
7. Dispatch, then the `maxResponseBytes` check on the result.

### 3.3 The upgrade, identity and authentication

The server does these steps in this order, all before `101`. A step that fails
answers with its HTTP status, and the server releases every slot that an
earlier step reserved. If the upgrade has not reached `101` within
`upgradeTimeoutMs` (default 10 s), the server releases every slot it reserved
and answers `503`. Once Node emits `'upgrade'`, its own `headersTimeout` and
`requestTimeout` no longer apply, so this deadline is the only one.

1. **Check `Origin`** (see the policy below). Failure: `403`.
2. **Check the subprotocols.** The client must offer `agentback.jsonrpc.v0`.
   A `bearer.<token>` entry must be an RFC 7230 token: every character is a
   `tchar`. If the upgrade has both an `Authorization` header and a `bearer.`
   entry, the server refuses it as ambiguous. Failure: `400`.
3. **Reserve a server-wide slot** (`maxConnections`). Failure: `503` with
   `Retry-After`. The server reserves the slot at this check, so parallel
   upgrades cannot go over.
4. **Run the gate**, if the options have `strategyAuth`. Before the gate runs,
   the server checks `maxUpgradesInGatePerAddress` (default 8) for the
   client address; over it the upgrade gets `429`. So one address cannot hold
   every server-wide slot with upgrades that wait inside a slow strategy.
   - Each named strategy runs on the upgrade request through a private adapter
     that builds the exported `AuthRequest` interface (`method`,
     `headerValue`, `query`) from the upgrade request.
   - The chain is the `/mcp` chain: strategies run in order, a strategy that
     throws passes to the next, and the first that returns a profile wins.
   - If none returns a profile: with `required: true` (the default) the
     upgrade gets `401`; with `required: false` it continues as anonymous,
     **unless a strategy threw**, which gets `401`. That last case differs
     from `frameworkAuthGuard` on `/mcp`, which treats it as anonymous: bad
     credentials on a long-lived connection must fail loud. For the same
     reason, an `anonymous` strategy in the chain throws at install (§3.1).
     The option's TSDoc and an install-time `debug` line say so.
   - If the options have no gate, every connection is anonymous.
   - A strategy may return only a client application (client credentials):
     the server binds `SecurityBindings.CLIENT_APPLICATION`, the client key is
     `client:<id>`, `callTool` gets no user principal (with
     `noLocalPrincipal`), and the scopes default to the application's
     `allowedScopes`.
5. **Reserve a per-client slot** (`maxConnectionsPerClient`), keyed by the
   client key. This step comes after the gate, because the gate decides the
   principal. Failure: `429` with `Retry-After`.

The `503` and `429` above send `Retry-After: 5`. A connection slot has no
window that would give a better value, so this is an estimate.

**Refused upgrades are diagnosable.** A browser's `WebSocket` API never shows
the status or body of a refused upgrade; the page sees `onerror` and close code
`1006`. So every refusal does three things:

- its body is an error envelope with a `hint` (for a non-browser client);
- the server logs it at `warn`, rate-limited, with the problem, the cause and
  the fix, for example `upgrade /ws refused 403: Origin https://app.example.com
≠ computed origin http://10.0.0.5:3000; set expressApp.set('trust proxy', …)
or allowedOrigins`, or `upgrade /ws refused 400: no 'agentback.jsonrpc.v0'
subprotocol offered`;
- with the `ws` package as the client's `WebSocket`, `createWsClient` rejects
  `connect()` with `WsUpgradeRefusedError` carrying the status and the envelope
  (§3.8).

The guide has a troubleshooting table that maps each refusal to its fix, and a
`wscat -c ws://localhost:3000/ws -s agentback.jsonrpc.v0` recipe.

**The path rule.** The upgrade `path` is matched exactly, without `basePath`,
as `upgrade()` matches it.

**Origin policy.** A browser sends `Origin` on every WebSocket upgrade, and a
cookie is sent with it automatically. So this check is the defence against
cross-site WebSocket hijacking, and it is strict:

- **Same origin passes.** The server compares the `Origin` scheme, host and
  port with the upgrade's own origin, which is the scheme and host that a
  browser used. Both sides are normalized first: default ports (`:443` for
  `https`, `:80` for `http`) are removed, the host is lower-cased, and IPv6
  brackets are compared as written by the WHATWG `URL` parser.
- On the Express host, the server computes the upgrade's origin as Express
  does for `req.protocol` and `req.host`: it reads
  `expressApp.get('trust proxy fn')` and applies it to the socket address with
  `proxy-addr`. If the peer is trusted, `X-Forwarded-Proto` and
  `X-Forwarded-Host` count; if not, the server uses `https` only when TLS ends
  here, and the `Host` header. `trust proxy fn` is an internal Express setting,
  so a test pins the behaviour. On the native host, the server trusts no
  forwarded header, so behind a proxy a native app sets `allowedOrigins`.
- **`allowedOrigins` passes.** Each entry is an exact origin
  (`https://app.example.com`), or the option is a predicate
  `(origin, upgrade) => boolean` for apps whose CORS uses a RegExp or a
  callback.
- **Every exact origin string in `rest.cors.origin` passes.**
- **`localhost`, `127.0.0.1` and `::1` pass on any port only when the upgrade's
  own host is also loopback**, for development. On a public host they do not
  pass, because any page on a user's machine could otherwise open the socket
  with that user's cookie.
- **A missing `Origin` passes**, because only browsers send it.
- **`Origin: null` is present and cross-origin** (`403`). A sandboxed iframe or
  a `file://` page sends it; it is not the same as a missing header.
- A CORS `RegExp` or callback origin, or `cors: true`, is not enumerable, so it
  adds nothing. The server logs one warning at install that names
  `allowedOrigins`. `allowedOrigins: '*'` turns the check off, and the server
  logs a warning at install.

This policy is deliberately not the `/mcp` one. The `/mcp` helpers depend on
the MCP SDK, and without `rest.cors` they allow localhost only.

**Pinned request identity.** The server copies these values from the upgrade
once:

- `Authorization`, `Cookie`, `Proxy-Authorization` and `Origin`;
- `Host`, `Forwarded` and every `X-Forwarded-*` header;
- the client-IP headers that platforms and proxies set: `CF-Connecting-IP`,
  `True-Client-IP`, `X-Real-IP`, `X-Client-IP`, `X-Cluster-Client-IP`,
  `Fastly-Client-IP`, `Fly-Client-IP` and `X-Vercel-Forwarded-For`, plus every
  name in the `pinnedHeaders` option. Over HTTP the edge overwrites these on
  each request; over a connection it sees only the upgrade, so the upgrade's
  values are the only true ones;
- the remote address of the socket, and whether the upgrade came over TLS.

The gate re-run and the tool rate limiter read these values. In phase 2, every
`http.request` also carries them, and a call cannot change them (§3.9).

**The gate runs again before every call and every server request.** If the
gate exists, the server runs it again before each `tool.call`, `tool.list` and
`WsConnection.request()` or `call()`. Only `ping` and
`notifications/cancelled` skip it. The re-run uses the request
`{method: 'GET', url: <the upgrade path and query>, headers: <the pinned headers>}`,
so a strategy that reads the query sees the same query as at the upgrade. The
re-run must give **the same principal id as the upgrade**, and an anonymous
connection must stay anonymous. If the re-run fails, returns a different
principal, or returns none for a connection that had one, the server sends no
reply to that call, aborts every in-flight call's signal and closes the
connection with code `4401` ("authentication expired").

**An idle connection also expires.** The re-run sees only connections that send
or receive calls. So when the gate's result exposes a credential expiry (a JWT
`exp`, an introspection `exp`, or an `expiresAt` that the strategy returns),
the server schedules a `4401` close at that time, and `localForPrincipal()`
stops returning the connection then. There is no re-check interval option. A
strategy that exposes no expiry relies on the per-call re-run alone.

A `tool.call` gets its principal from the gate run before that call. A tool
has no `@authenticate` of its own, so the gate is the only source of a tool
principal. Without a gate, a `tool.call` has no principal.

**The tool identity matches `/mcp`.** After a gate, the connection context binds
`MCPBindings.REQUEST_AUTH` in the shape that `frameworkAuthGuard` produces
(`{token: 'framework', clientId: <principal id>, scopes, extra: {user,
clientApplication}}`). So `callTool` resolves identity on the same path as
`/mcp`, and a tool that injects `REQUEST_AUTH` sees the same value.

**No `localPrincipal` over a connection.** With no principal, `callTool` falls
back to `MCPServerConfig.localPrincipal`, the identity of the local operator on
stdio. A remote caller must never get it; `/mcp` already refuses it for
anonymous HTTP. So `CallToolOptions` gets a flag, `noLocalPrincipal: true`, and
the bridge sets it on every `tool.call`.

**No payment proof over a connection.** A priced tool reads its proof from
`MCPBindings.REQUEST_INFO` (`x-payment`), and a `tool.call` carries no headers
per call. The bridge never builds `REQUEST_INFO` from the pinned upgrade
headers, because that would replay one proof for every call on the connection.
So priced tools are refused at install (§3.1).

**Browsers cannot set headers on a WebSocket.** The design supports two ways:

- **A cookie.** The browser sends it on the upgrade. The Origin check stops
  cross-site WebSocket hijacking.
- **A bearer token as a second subprotocol**, `bearer.<token>`. The server
  turns it into `Authorization: Bearer <token>`, using the value as it is,
  without decoding. A JWT is already a valid token. A token with any
  non-`tchar` character cannot use this way and must use a cookie. The server
  never sends the entry back in `Sec-WebSocket-Protocol`, and never logs it. A
  proxy between the client and the server can log `Sec-WebSocket-Protocol`, so
  a client that can set headers should send `Authorization` instead.

Single-use query tickets are out of v1. The gate runs again before every call,
and a used ticket cannot pass again.

**Contexts.** The connection context is a child of the app context. It binds:

- `WsBindings.CONNECTION`, the `WsConnection` handle (§3.5);
- `CoreBindings.ABORT_SIGNAL`, which aborts when the connection closes;
- `SecurityBindings.USER` and `MCPBindings.REQUEST_AUTH`, if the gate found a
  principal.

The server closes the connection context when the connection closes, so its
views and observers do not accumulate.

Each call has its own signal. That signal aborts when the connection closes,
when the client sends `notifications/cancelled` for that call, or when
`callTimeoutMs` passes. The bridge passes it to `callTool`, so the tool's
`CoreBindings.ABORT_SIGNAL` sees it.

**Messages during `onConnect`.** The server attaches its `'message'` listener
before it completes the upgrade. While an async `onConnect` runs, the server
queues incoming messages, and the queue counts against `maxInFlight`. A call
over the limit gets its `-32000` (`statusCode: 429`) reply at once, and a
notification over the limit is dropped and counted, as after `onConnect`. When
`onConnect` resolves, the server dispatches the queue in order. If `onConnect`
throws, or has not resolved within `onConnectTimeoutMs` (default 10 s), the
server closes the connection with `1011` and drops the queue.

**Liveness.** The server sends a WebSocket ping every 30 s. If a pong does not
arrive before the next ping, the server terminates the connection, and
`onDisconnect` gets code `1006`. The JSON-RPC `ping` is for the application.

### 3.4 Tool dispatch

**What a connection carries.**

- `tools` defaults to **none**. An app can serve a tool only over stdio, so the
  app must opt in: `tools: true`, or `tools: {include}`.
- **The carried set is fixed at install.** At install, `selectTools({include})`
  from `@agentback/mcp` gives the carried set, the same predicate as
  `@agentback/agents` and `@agentback/command`. It runs with no scopes, so an
  include entry that names no tool fails at install. Three kinds of tool are
  **not carried in v1**: `confirm:` tools, tools that inject
  `MCPBindings.ELICIT`, and priced tools. If an include list names one, install
  throws (§3.1, §4). A duplicate tool name at install also throws, as it does
  for `@agentback/agents` and `@agentback/command`. A tool bound after install
  is not carried.
- **Visibility runs on every `tool.call` and every `tool.list`.** For each
  call, the bridge reads `MCPServer.servedTools()`, the same list `/mcp` serves:
  one tool per name, the root-nearest binding. A tool is visible if its name is
  in the carried set and its required scopes (`requiredScopesForTool`, already
  exported from `@agentback/mcp`) are all in `scopes`. If the served winner for
  a name is hidden by scope, the name is hidden; the bridge never falls back to
  another binding with that name. The bridge does not call `selectTools` per
  call, because it throws on an unmatched include and on a duplicate name.
- **The `scopes` rule is the `/mcp` rule.** If the options have a gate,
  `scopes` is the principal's scopes or `[]`, **never `undefined`**. If the
  options have no gate, `scopes` is `undefined`, and every carried, live tool is
  visible. The principal's scopes come from the `strategyAuth.scopes` option.
  Its default is the `/mcp` default: the user's `scopes`, else the client
  application's `allowedScopes`. That default is the shared
  `principalScopes(auth)` from `@agentback/mcp`, which phase 1 also uses to
  replace the two private copies in `@agentback/mcp-http`.
- `tool.call` checks the name against the visible tools **before** it calls
  `callTool`. If the tool is not visible, the reply is an `AgentError` with
  code `not_found`, the same result as an unknown name. This covers a tool that
  was unbound after install. Without this check, `callTool` throws a plain
  `Unknown tool` error, and the envelope would redact it to a 500.
- The bridge calls `callTool(name, input, {ctx, principal, signal, binding,
noLocalPrincipal: true})`, with the connection context as `ctx` and the
  visible binding as `binding`. Passing the binding means `callTool` runs the
  exact tool that passed the check, so there is no gap between the check and
  the call. A tool can `@inject(WsBindings.CONNECTION)`.

**Tool rate limit.** `/mcp` limits tool calls with `rateLimit` on
`installMcpHttp`. Phase 1 moves that limiter, `createToolRateLimiter`, from
`@agentback/mcp-http` into `@agentback/mcp`, and both mounts use it. It gets a
per-call entry point, `checkCall(name, caller)`, beside the existing
`check(body, caller)` that `/mcp` uses, so the bridge never builds a fake
`tools/call` body. If `tools.rateLimit` is set:

- The caller has `header()` over the pinned headers, `ip` = the client address,
  and after a gate `authInfo` = the `REQUEST_AUTH` value above, so a
  `keyGenerator` written for `/mcp` reads the same fields.
- Without a `keyGenerator`, the key is the **client key** (§3.6), so a custom
  `clientKey` also sets the tool bucket.
- Over the limit, the reply is code `-32029` with
  `data: {code: 'rate_limited', retryAfterSecs}`, because a socket has no
  `Retry-After` header. The connection stays open.

**The limit is shared with `/mcp` only through a shared store.** Each
`createToolRateLimiter()` call builds its own limiter, and with the default
memory store `/mcp` and `/ws` each have their own budget, so a caller that uses
both gets both budgets. To give one principal one budget across both surfaces,
pass the same Redis `store` and `keyPrefix` to both. The doc of the option says
so.

**Concurrency.** Calls on one connection run at the same time. Replies can come
back in any order. The ids correlate them. §3.6 sets the limits.

### 3.5 Server requests

Each connection has a `WsConnection` handle:

```ts
interface WsConnection {
  readonly id: string;
  readonly principal?: UserProfile; // set if the gate found a principal
  readonly signal: AbortSignal; // aborts on close
  call<P, R>(
    remote: RemoteMethod<P, R>,
    params: P,
    opts?: {signal?: AbortSignal; timeoutMs?: number},
  ): Promise<R>;
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
- If a server request times out or its own signal aborts, the promise rejects,
  and the server sends `notifications/cancelled {requestId}` to the client. If
  the connection closes, the promise rejects and nothing is sent. The server
  decides between these cases by which signal fired, not by the error's shape.
  The server drops a reply that comes after the promise settled.
- If the client replies with a JSON-RPC error, the promise rejects with a
  `RemoteError {code, message, data}`.
- If the gate exists and fails before the request, the connection closes with
  `4401` (§3.3), and the promise rejects.

**Typed server requests.** `defineRemoteMethod({method, params, result})` joins
a method name to two Zod schemas. It and `RemoteError` live in
`@agentback/client`, which is browser-safe, so the server and a browser client
import the same object. The two sides mirror each other: the server calls
`conn.call(remote, params)`, and the client answers with
`client.handle(remote, fn)`. `conn.call` validates the params before it sends
them, which finds bugs in the server. It validates the result when it arrives,
which finds bugs in the client. `request()` and `notify()` stay available for
dynamic cases.

**There are no client-defined socket methods.** A client calls the app only
through carried tools (and, in phase 2, routes); the app defines no `@message`
handler. That is the one-source-of-truth rule. For chat or presence, the client
sends each message as a `tool.call` **with an `id`**, so it learns when a
message is refused, and the server uses `conn.notify()` for the
server-to-client side. A tool called as a notification also works, but it is
dropped without a signal over `maxInFlight`. The guide shows this pattern.

**How app code gets a connection:**

1. **`onConnect(conn, ctx)` and `onDisconnect(conn, reason)`** in the install
   options. Use them for presence and per-connection setup.
2. **`@inject(WsBindings.CONNECTION)`** in a carried tool, because `callTool`
   runs in the connection context.
3. **`WsBindings.REGISTRY`**, a port (`WsRegistry`) with an in-memory adapter
   in v1: `list()`, `get(id)`, `localForPrincipal(principalId)` and `stats()`.
   A service or a job uses it to send to the connections of one user or one
   host. The v1 adapter holds the connections of **this process only**. The
   method name says so, because an empty result means "not connected to this
   process", not "not connected". Behind a load balancer, a job on another
   process finds nothing; a later phase adds an adapter that reaches other
   processes without changing this API.

**Recovery and uncertain outcomes.** A connection can drop at any time. The
client reconnects; the server does not. If a connection closes while a server
request is pending, the promise rejects with `WsDisconnectedError`
(`code: 'disconnected'`), which means **the outcome is unknown**: the client may
have done the work before its reply was lost. So a server request that changes
state must be safe to send again, or it must carry a request id that the client
uses to drop a repeat. A client call that was in flight when the connection
dropped is the same from the client's side. The design gives no delivery
guarantee beyond this (§9).

### 3.6 Errors, limits, backpressure and shutdown

**No error escapes a message handler.** A throw from a `'message'` listener
stops the process. Each dispatch therefore runs inside a try/catch, as the
`'upgrade'` listener of `upgrade()` does.

| Event                                                                       | Result                                                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The frame is not valid JSON                                                 | Reply `-32700` with `id: null`. The connection stays open.                                                                  |
| The frame is binary                                                         | Close `1003`.                                                                                                               |
| The frame is larger than `maxRequestBytes` (default 1 MiB)                  | Close `1009`. `ws` enforces this limit. `perMessageDeflate` is off explicitly, so a compressed frame cannot expand past it. |
| A notification arrives when `maxInFlight` is reached                        | The server drops it, logs it at `warn` and counts it in `stats().droppedNotifications`.                                     |
| `onConnect` throws or passes `onConnectTimeoutMs`                           | Close `1011`. The server logs the error.                                                                                    |
| `onDisconnect` throws                                                       | The server logs the error.                                                                                                  |
| The gate fails before a call or a server request, or the credential expires | Close `4401`.                                                                                                               |
| `bufferedAmount` is more than `backpressure.closeBytes` (default 16 MiB)    | Close `1008` ("slow consumer").                                                                                             |
| `app.stop()` or `uninstall()`                                               | The shutdown order below, then close `1001`.                                                                                |

Every server-initiated close sends a reason (≤ 123 bytes) that names the fix:
`1003` "binary frames are not supported; send JSON text", `1008` "slow
consumer: more than 16 MiB buffered", `1009` "frame larger than
maxRequestBytes", `1011` "onConnect failed", `1001` "server stopping", and
`4401` "authentication expired: reconnect with fresh credentials".

Origin, subprotocol, limit and gate failures at the upgrade happen **before**
`101`. They are HTTP statuses (`403`, `400`, `503`, `401`, `429`), never close
codes.

**Limits.** Each limit is an install option. The defaults are estimates.
`maxConnections` matches `rest.resumable.maxLiveStreams`.

| Option                        | Default | When the limit is reached                                                                                                                                                                                                             |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxConnections`              | 1000    | The next upgrade gets `503` with `Retry-After` (step 3).                                                                                                                                                                              |
| `maxUpgradesInGatePerAddress` | 8       | The next upgrade from that address that would enter the gate gets `429` (step 4).                                                                                                                                                     |
| `upgradeTimeoutMs`            | 10 s    | The upgrade releases its slots and gets `503`.                                                                                                                                                                                        |
| `maxConnectionsPerClient`     | 16      | The next upgrade from that client key gets `429` with `Retry-After` (step 5).                                                                                                                                                         |
| `maxInFlight`                 | 32      | The next call on that connection gets `-32000` with `data: {statusCode: 429, code: 'rate_limited', retryAfterSecs: 1}`. A client handles both "slow down" errors by reading `data.code === 'rate_limited'` and `data.retryAfterSecs`. |
| `maxInFlightTotal`            | 4096    | The next call on any connection gets the same reply as `maxInFlight`.                                                                                                                                                                 |
| `callTimeoutMs`               | 300 s   | The call's signal aborts, and the reply is `-32000` with `data.statusCode: 504`.                                                                                                                                                      |
| `maxPendingRequests`          | 128     | `WsConnection.request()` rejects at once with a `WsLimitError` (`code: 'pending_limit'`).                                                                                                                                             |
| `maxResponseBytes`            | 1 MiB   | A `tool.call` result gets `-32000` with `data.statusCode: 413` (§3.2).                                                                                                                                                                |
| `tools.rateLimit`             | none    | A `tool.call` gets the `/mcp` error `-32029` (§3.4).                                                                                                                                                                                  |

**Client key.** After a gate that found a principal, the client key is the
principal id. Otherwise it is the client address. On the Express host, the
client address follows the Express app's `trust proxy` setting
(`server.expressApp.set('trust proxy', …)`), the same rule that gives `req.ip`
over HTTP. On the native host, it is the socket's remote address. Behind a load
balancer without that setting, every client has the balancer's address, so set
`trust proxy` or pass a `clientKey(upgradeRequest, principal)` function.

**Backpressure.** A slow client must not hold unbounded server memory.

- While a connection's `bufferedAmount` is more than `backpressure.pauseBytes`
  (default 1 MiB), the server stops reading that connection's inbound frames
  (it pauses the socket). TCP then pushes back on the client, so a client that
  sends calls faster than it reads replies slows down instead of being closed.
- At `backpressure.closeBytes` (default 16 MiB) the server closes the
  connection with `1008`.
- `maxInFlightTotal` bounds the work that all connections together can start.
  Without it, the per-connection limits multiply: 1000 connections × 16 MiB
  `closeBytes` is about 16 GB [estimated].

**Shutdown order.** On `app.stop()` and on `uninstall()`, the server:

1. stops accepting upgrades;
2. aborts the signal of every in-flight call and every pending server request;
3. waits up to 5 s [estimated] for in-flight dispatch to finish, so no tool
   runs after the app's lifecycle teardown (for example after a database pool
   closes);
4. closes every connection with `1001` and closes each connection context.

**Logging and stats.** The namespace is `agentback:ws`, through `loggers`.

- The server logs each open and close at `debug`: connection id, close code and
  duration. It logs every `1008`, `1011` and `4401` close at `warn`.
- A log line for a call has the method, the id and the connection id only. The
  server never logs a pinned header, the `bearer.` subprotocol or a message
  body.
- `WsBindings.REGISTRY.stats()` returns
  `{open, inFlight, closedByCode, droppedNotifications, unmatchedResponses}`.

### 3.7 New public API outside `@agentback/ws`

Each item is small, and each exists because the bridge cannot reach the
behaviour it needs through an existing export.

| API                                                                                        | Package                                 | Why                                                                                                                                              |
| ------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CallToolOptions.noLocalPrincipal`                                                         | `@agentback/mcp`                        | stops a remote caller from running as the local operator (§3.3)                                                                                  |
| `createToolRateLimiter` (moved from `@agentback/mcp-http`), with `checkCall(name, caller)` | `@agentback/mcp`                        | one tool limiter for `/mcp` and `/ws`, with no dependency on the HTTP mount package and no fake request body (§3.4)                              |
| `principalScopes(auth)`                                                                    | `@agentback/mcp`                        | one scope derivation; replaces the two private `defaultScopes` copies in `@agentback/mcp-http`, and `/ws` uses it as its `scopes` default (§3.4) |
| tool-call `meta.transport`, `UsageDescriptor.surface: 'ws'`                                | `@agentback/mcp`, `@agentback/metering` | the usage tag and the server-request event (§4)                                                                                                  |
| `ErrorCodes.PAYLOAD_TOO_LARGE`                                                             | `@agentback/openapi`                    | a named code for the 413 reply; HTTP behaviour does not change (§3.2)                                                                            |
| `defineRemoteMethod`, `RemoteError`, `createWsClient` and its errors                       | `@agentback/client`                     | one typed server-request contract and one client for server, browser and tests (§3.5, §3.8)                                                      |
| `upgrade` probe kind, `createTestApp({ws})`                                                | `@agentback/testing`                    | conformance and test client (§5.6, §5.8)                                                                                                         |

Phase 2 adds four `@agentback/rest` items, listed in §3.9.

### 3.8 The client: `createWsClient`

`createWsClient` lives in `@agentback/client`, next to `createClient`, and stays
browser-safe.

```ts
import WebSocket from 'ws'; // Node only, and only when you need headers

const c = createWsClient({
  url: 'wss://app.example.com/ws',
  token: () => getAccessToken(), // optional; string or async resolver, called on each connect()
  WebSocket, // optional constructor; default: globalThis.WebSocket
  headers: {authorization: 'Bearer …'}, // optional; only with a constructor that takes options, such as ws
  requestTimeoutMs: 30_000,
});
c.handle(heartbeat, async params => ({ok: true})); // register before connect: no race
await c.connect(); // resolves on open
const out = await c.tool('forecast', {city: 'Tokyo'}, {signal});
c.closed.then(({code, reason}) => {
  /* the app decides whether to reconnect */
});
await c.close();
```

- **Readiness.** Handlers registered with `handle()` before `connect()` are
  active when the socket opens, so a server request sent during `onConnect`
  never meets a missing handler. A method with no handler replies `-32601`.
- **No `ws` import.** `@agentback/client` never imports `ws`, not even
  dynamically, because a bundler would pull it into a browser build. A Node
  caller passes `WebSocket` from `ws`. `headers` are accepted only with a
  constructor that takes options; otherwise `createWsClient` throws locally
  with a hint that names `ws`.
- **Credentials.** `token` builds the `bearer.<token>` subprotocol entry. A
  token with a non-`tchar` character throws locally, before any network call,
  with the hint "use a cookie or Authorization header".
- **Reconnect is the app's job in v1.** The client does not reconnect and never
  replays a call whose outcome is unknown. `closed` resolves with the code and
  reason, and the app calls `connect()` again (the token resolver runs again).
- **Errors** follow `ClientError`'s style (`code`, `message`, `data`, and
  `status`/`body` where HTTP applies):
  - `WsUpgradeRefusedError`, with the status and the envelope when the
    constructor is `ws` (its `unexpected-response` event exposes them; a
    browser's and Node's global `WebSocket` do not);
  - `WsAuthExpiredError` (`4401`; pending calls reject with it, so the app
    refreshes its token and reconnects);
  - `WsDisconnectedError` (outcome unknown);
  - `RemoteError` (a JSON-RPC error reply). A `-32000` reply exposes `data` as
    the server's `ErrorEnvelope`.
- **Typed helpers.** `tool` returns a typed result from generics in v1. Phase 2
  adds `http` and `stream` (§3.9), and phase 3 types them from `defineRoute`
  descriptors.
- **The test client is the same object.** `createTestApp(App, {ws})` returns a
  connected `createWsClient` instance as `.ws`.

### 3.9 Phase 2: carried routes (`http.request`)

Phase 2 lets a connection call the app's `@api` routes. This section keeps the
design that the review hardened. Nothing in it ships in phase 1.

**Option and method.** `WsOptions` gains `routes?: boolean | {include: string[]
| ((method: string, path: string) => boolean)}`. The default is `true` in phase 2. A prefix that matches no route throws at install, and a route outside the
subset answers `status: 404`.

| Method         | Params                                    | Result                                   |
| -------------- | ----------------------------------------- | ---------------------------------------- |
| `http.request` | `{method, path, query?, headers?, body?}` | `{status, headers, body, bodyEncoding?}` |

The server can then also send `http.stream`.

**`http.request` keeps HTTP meaning.** A route that answers 404 or 422 gives a
normal JSON-RPC **result** with that `status` and the route's own error body. It
is the same response that HTTP would give. This rule makes parity testable.

- `path` is the full request path, with `basePath`, as over HTTP. It must start
  with a single `/`, and it must not hold a query: an absolute URL, a `//`
  prefix or a `?` gets `-32602`. The bridge parses `path` once with the WHATWG
  `URL` parser, and if the parsed pathname differs from `path` (for example
  because of `.` or `..` segments), the call gets `-32602`. The bridge then uses
  that one pathname for both the route match and the dispatch. `createWsClient`
  percent-encodes the path it sends.
- `query` and params `headers` are `Record<string, string | string[]>`.
- `OPTIONS` gets `status: 404`; no `@api` route serves it.
- `body` is JSON. The bridge sends it as `application/json` and sets
  `content-type` itself. A route whose body is not JSON (for example
  multipart) gets `-32000` with `data.statusCode: 415` and a hint to use HTTP.
- `headers` in the result is `Record<string, string | string[]>`. **`set-cookie`
  and `set-cookie2` are removed**, because page script never sees them over
  HTTP, and a session cookie in a script-visible result would defeat
  `HttpOnly`. A new cookie needs a new connection anyway: the pinned `Cookie`
  does not change.
- A reply body decodes by content type. JSON stays JSON. `text/*` becomes a
  string. Any other type becomes base64 with `bodyEncoding: 'base64'`.
- A reply body larger than `maxResponseBytes` is not sent; the limit counts raw
  body bytes before base64 and applies to each `http.stream` item. The reply is
  the `413` error from §3.2. Use HTTP for large downloads such as `serveFile`
  routes.
- A `streamOf` route sends one `http.stream` notification for each item,
  `{requestId, data}`, then the final result `{status, headers}`. If the
  producer throws after the first item, the final reply is `-32000` with the
  SSE error envelope. A streaming route called as a notification runs, and the
  bridge discards its items.
- A `resumable:` route is **refused**: `-32000` with `data.statusCode: 400` and
  `data.code: 'invalid_parameter'`. Its producer would otherwise outlive the
  call by `windowMs` and hold a `maxLiveStreams` slot that no client can resume.
- A `404` whose path does not start with `basePath` has a `hint` that names
  `basePath`.

**Pinned identity per call.** Every `http.request` carries the pinned request
identity (§3.3), so the route's own `@authenticate`, its Origin checks and the
rate limiter see the same values as over HTTP. A call cannot change it: if
`params.headers` holds a refused header, the server answers `-32602` with
`data: {code: 'header_refused', header, reason, hint}`. It does not drop the
header silently. The refused headers are:

- every pinned header, even when the upgrade did not carry it;
- every header that the Fetch standard forbids a browser script to set
  (`Content-Length`, `Referer`, `Connection`, `Upgrade`, `Transfer-Encoding`,
  `Expect`, `TE`, `Trailer`, `Keep-Alive`, `Via`, `Date`, `DNT`, `Set-Cookie`,
  `Cookie2`, `Accept-Charset`, `Accept-Encoding`, `Access-Control-Request-*`,
  and any name that starts with `Proxy-` or `Sec-`);
- the method-override family: `X-HTTP-Method`, `X-HTTP-Method-Override` and
  `X-Method-Override`;
- `Content-Type`, which the bridge sets from `body`.

Names match without regard to case. The refused list is one module, and a test
covers each entry. Without a gate, a carried route still runs its own
authentication on each call, and a `401` from the route is a normal result.

**The parity rule.** A call gets the same response that the same HTTP request
from the same client gets **on this app**. Anything in front of the app sees
only the upgrade: an API gateway, an access log, a WAF and a gateway quota never
see the calls. An app that relies on those for HTTP must apply them in the app
(for example `installRateLimit`) before it carries routes. Dispatch follows the
host:

| Host                       | `http.request` runs through                                                                | So these run                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Express listener (default) | [`light-my-request`](https://github.com/fastify/light-my-request) into `server.expressApp` | The full Express chain: CORS, body parsing, `app.middleware()`, `installRateLimit`. Routes that inject raw `req`/`res` work too. |
| Native listener            | `server.fetchHandler().fetch(Request)`                                                     | The same pipeline as HTTP on that host, with `app.webMiddleware()`.                                                              |

`light-my-request` (6.6.0, BSD-3-Clause) is the base of `fastify.inject`. It is
already in the lockfile, and only `@agentback/ws` would depend on it. The review
read its source and found four gaps that phase 2 must close by design:

1. **Cancellation.** `Request.prototype.destroy` returns early once the request
   body has been read (`lib/request.js`), and body parsing reads it for every
   JSON POST. So its `signal` option cannot cancel a POST route. Phase 2 runs
   each `inject` inside an `AsyncLocalStorage` store `{signal, transport:
'ws'}` that `@agentback/rest` exports. `RestServer.invokeRoute` binds
   `CoreBindings.ABORT_SIGNAL` to `AbortSignal.any([nodeAbortSignal(res),
store.signal])`, and reads `transport` from the same store. A header cannot
   forge the transport tag, because no header sets it.
2. **Backpressure.** The REST stream sink waits for `'drain'` only when
   `res.writableNeedDrain` is set, and under `inject` that flag is never set.
   Phase 2 makes the sink wait for `'drain'` whenever `res.write()` returned
   `false`. The bridge also counts response bytes it has not read yet and
   closes with `1008` at `backpressure.closeBytes`. While `bufferedAmount` is
   over `pauseBytes`, the bridge stops reading the response body.
3. **Buffering.** Without `payloadAsStream`, `light-my-request` collects the
   whole body before the bridge can check its size. Phase 2 always reads with
   `payloadAsStream`, counts bytes while it reads, and destroys the response at
   `maxResponseBytes`.
4. **TLS and routing parity.** Its mock socket has no `encrypted` flag, so a
   route would see `req.secure === false` over TLS. Phase 2 sets `encrypted`
   when the upgrade came over TLS. The route match must also follow the
   Express app's own `case sensitive routing` and `strict routing` settings,
   trailing-slash tolerance and parameter decoding.

**Only `@api` routes are carried.** `server.expressApp` and `fetchHandler()`
also serve other mounts: `/mcp`, `/explorer`, the console's static shell, static
files and every `addFetchHandler` entry. The bridge does not carry these. Some
framework UIs are `@api` controllers (for example the `console-chat` bridge and
the `console-agents` turn route), so they are carried, and each runs its own
authentication, as over HTTP. Before it dispatches, the bridge matches the
method and normalized pathname with a new public `RestServer.matchRoute(method,
path)`. On the native host it is the fetch `Router` that serves HTTP. On the
Express host, Express exposes no matcher, so `matchRoute` builds a second
`Router` from the same `collectRoutes` output with Express 5's rules (`HEAD`
folded to `GET`, and the app's case and strict settings). If no `@api` route
matches, the result is `status: 404`, and nothing is dispatched.

**Streams on the Express host.** The bridge parses SSE or JSONL frames from the
response stream back into items with the parsers in `@agentback/client`
(`sse.ts`, `ndjson.ts`).

**Phase 2 `@agentback/rest` API.**

| API                                                     | Why                                                               |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| `RestServer.matchRoute(method, path)`                   | carries `@api` routes only, with each host's match rules          |
| the `{signal, transport}` `AsyncLocalStorage` store     | cancellation and the transport tag through `inject` (gap 1 above) |
| a stream sink that honours `res.write()`'s return value | backpressure through `inject` (gap 2 above)                       |
| `RestDispatchInfo.transport`                            | tells socket traffic apart from HTTP in usage events              |

Gaps 1 and 2 change the HTTP path. The existing `streamOf` backpressure and
cancellation suites on the Express, web-dispatch and native hosts must stay
green, and a request outside the store must see an unchanged signal.

**Phase 2 risks.**

- **Two dispatch paths can drift.** The Express path uses injection and the
  native path uses `fetchHandler()`. The parity suite runs on both hosts.
- **Injection overhead.** Each `http.request` on the Express host builds a
  simulated request and response. Phase 2 measures the median time of the
  parity GET case over the socket against the same request over HTTP. If the
  socket is more than 2× slower, phase 2 stops and asks. The fallback is
  `fetchHandler()` for routes that no Express-only middleware touches, which is
  a parity trade-off with its own decision.
- **Native streaming.** Phase 2 checks that `Response.body` on the native host
  pulls lazily from the route's iterator, so that stopping the read pauses the
  producer.

**Phase 2 client.** `createWsClient` gains `http(method, path, {query, body,
signal})` and `stream(method, path, {signal})`, an `AsyncIterable` over
`http.stream` items whose signal abort sends `notifications/cancelled`.

**Phase 2 tests.** Each case runs on both listeners unless it says otherwise,
and compares status, body and error envelope with the same HTTP request:

- a GET with path and query parameters, and a POST with a JSON body;
- a 422 validation failure, and a 404 unknown path;
- a path that HTTP serves but that is not an `@api` route (`/mcp`, a static
  file): the socket gets `404`;
- a route that needs authentication, with a token and without one;
- a 403 from `@authorize`;
- a rate-limited route (**Express listener only**: `installRateLimit` has no
  fetch path): calls count against the same IP as HTTP;
- a plain `Error`, redacted to `internal_error`;
- a `streamOf` route: the `http.stream` items equal the SSE items, and a
  producer that throws after one item gives one item and then `-32000`;
- a reply over `maxResponseBytes`, and one `http.stream` item over it, give
  `413`, and an oversize non-stream body is refused without reading it whole;
- a `resumable:` route gives `-32000` with `data.statusCode: 400`;
- a `HEAD` request, a mixed-case path, a trailing slash and a percent-encoded
  segment match as they do over HTTP on each host;
- a route that sets two cookies: the result has no `set-cookie`, and the next
  call still carries the pinned `Cookie`;
- a path with `..` segments, an absolute URL, a `//` prefix and a `?` in
  `path` each give `-32602`, and nothing is dispatched;
- a route that reads `CF-Connecting-IP` sees the upgrade's value, and a call
  that sets it gets `-32602`; one case per refused header;
- `notifications/cancelled` aborts a **POST** route's signal on the Express
  host, and a close does too;
- a slow reader pauses a `streamOf` producer on the Express host, and the heap
  stays bounded;
- an upgrade over TLS: the route sees `req.secure === true`;
- `routes: {include: ['/api']}` carries `/api/x` and gives `404` for
  `/console/chat/x`;
- usage events for a carried route have `transport: 'ws'`, and the same call
  over HTTP has `transport: 'http'`.

## 4. Interaction with other features

- **`confirm:` tools and eliciting tools are not carried in v1.** `selectTools`
  excludes both, because a projected caller cannot do the round trip. A
  connection is different: the client is a live peer, and the server can send
  it a server request. So a later phase can carry both. A `confirm:` tool can
  use the token exchange (`confirmation_required`, then a second call with the
  token). An eliciting tool can send its question as a server request. Both are
  follow-ups (§7). Until then, `/mcp` serves these tools.
- **Priced tools are not carried in v1.** `@agentback/payments` reads the
  payment proof from each request's headers, and a `tool.call` has none (§3.3).
  A per-call payment field is a follow-up.
- **MCP Events (E-7).** The `EventDelivery` port is defined in `@agentback/mcp`
  (`events/ports.ts`). `WebhookEventDelivery` in `@agentback/mcp-events` is its
  only implementation. A WebSocket implementation of that port is a follow-up.
- **Metering and the usage tag.** A carried tool emits its normal `'mcp'` event.
  v1 adds `transport: 'http' | 'ws'` to the tool-call metering `meta`, so
  production traffic over a connection can be told apart from `/mcp`. A server
  request emits a usage event with `surface: 'ws'` and the method name, which
  adds `'ws'` to `UsageDescriptor.surface`. The kill criterion reads these
  events. Phase 2 adds the same tag for routes (§3.9).
- **Plugins.** A plugin that calls `installWebSocket` must do it before
  `app.start()`. The `upgrade()` freeze applies. Registration after start is a
  follow-up for `upgrade()` itself.
- **Edge hosts.** v1 runs on the Node host only. `upgrade()` is Node-only.
  Workers, Bun and Deno are a roadmap phase (§7).

## 5. Testing (phase 1)

Every integration test uses a real `ws` client. No test mocks the connection.
Each suite runs on both listeners with `describe.each`, as in
`upgrade.integration.ts`, unless a case says otherwise. Phase 2's tests are in
§3.9.

1. **Protocol.**
   - Invalid JSON gives `-32700`, and the connection stays open.
   - An unknown method gives `-32601` with `data.code: 'method_not_found'`.
     Without tools, `tool.call` gives `-32601` with
     `data.code: 'method_disabled'` and a hint naming the option, and
     `http.request` gives `method_disabled` with a hint naming phase 2.
   - A non-string, non-integer `id` gives `-32600`. A duplicate in-flight `id`
     gives `-32600` with `id: null` and `data.duplicateId`, and the first call
     still completes. A JSON array frame gets `-32600` with `id: null`. A frame
     with both `method` and `result` gets `-32600`. A response with an unknown
     `id` is dropped and counted.
   - A binary frame closes with `1003`. A large frame closes with `1009`, and a
     compressed frame cannot get past `maxRequestBytes`.
   - A call without an `id` gets no reply.
   - Messages sent during an async `onConnect` are all dispatched, in order,
     after it resolves; call 33 sent during it gets `statusCode: 429` at once.
     `onConnect` that throws, and one that never resolves, close with `1011`.
   - Each server-initiated close carries its reason text.
   - With 32 calls in flight, `notifications/cancelled` still cancels one, and
     `ping` still answers.
   - 32 concurrent calls that finish out of order each get their own reply.
   - A streaming `@tool` returns its collected array.
2. **Cancellation.** `notifications/cancelled` aborts the tool's
   `CoreBindings.ABORT_SIGNAL`, and so does a connection close and
   `callTimeoutMs`, which also replies `504`.
3. **Upgrade and identity.**
   - A failed gate gives `401`, with no `101`. A gate with `required: false`
     lets an upgrade without credentials through as anonymous, and still gives
     bad credentials `401`. An `anonymous` strategy in the chain throws at
     install.
   - 20 parallel upgrades with a gate that never answers do not block one good
     upgrade from another address; each hanging upgrade gets `503` after
     `upgradeTimeoutMs`, and upgrade 9 from one address inside the gate gets
     `429`.
   - A gate strategy that reads the query passes at the upgrade and on the
     re-run before the first call.
   - With `localPrincipal` configured and no gate, a tool called over the
     connection sees no `SecurityBindings.USER`.
   - After a gate, a tool that injects `MCPBindings.REQUEST_AUTH` sees the
     `frameworkAuthGuard` shape.
   - A cross-site `Origin` gives `403`, and so does `Origin: null`. A
     same-origin page passes with no `rest.cors` and no `allowedOrigins`, also
     when one side writes the default port. An `allowedOrigins` entry passes, an
     exact `rest.cors.origin` string passes, and a missing `Origin` passes. A
     `localhost` origin passes when the server's host is loopback and gets
     `403` when it is not. An `allowedOrigins` predicate decides an upgrade.
   - Behind a trusted proxy, a same-origin page whose host arrives in
     `X-Forwarded-Host` passes; from an untrusted peer, that header is ignored.
   - A missing subprotocol gives `400`. A `bearer.` token with `=` or a space
     gives `400`. `Authorization` and `bearer.` together give `400`.
   - The `bearer.<token>` subprotocol authenticates, and the server does not
     echo it.
   - A refused upgrade logs one `warn` line with problem, cause and fix (the
     Origin case names the computed origin), and its body is an envelope with
     a `hint`.
   - A strategy chain where the first strategy throws and the second succeeds
     authenticates, as on `/mcp`.
   - `{include: []}` for tools throws at install with the hint; an include
     typo throws naming the closest tool name; a priced tool in the include
     list throws.
   - A server request emits a usage event with `surface: 'ws'`.
   - With a gate, an expired token closes the connection with `4401` at the
     next call, at the next `tool.list`, and at the next server request. A
     `4401` during in-flight calls aborts their signals, and no reply follows
     the close.
   - An idle connection whose token has an `exp` closes with `4401` at that
     time, and `localForPrincipal()` no longer returns it.
   - A re-run that returns a different principal closes with `4401`. Under
     `required: false`, a re-run that returns none for an authenticated
     connection closes with `4401`, and an anonymous connection stays open.
   - A strategy that returns only a client application binds
     `SecurityBindings.CLIENT_APPLICATION`, and a tool sees no user.
   - With a gate, an anonymous principal cannot call or list a
     `@tool({scope})` tool, and the reply is `not_found`. Without a gate, the
     tool is visible.
   - With a second binding of a carried tool name mounted after install, where
     the served winner is scope-hidden, the name is hidden over the connection,
     as on `/mcp`.
   - A carried tool that is unbound after install gives `not_found`, not a 500,
     with a gate and without one.
4. **Server requests.** `request()` resolves with the reply. A JSON-RPC error
   rejects with `RemoteError`. A timeout sends `notifications/cancelled`; a
   close does not. A late reply changes nothing. A close rejects every pending
   request with `WsDisconnectedError` (`code: 'disconnected'`), not
   `RemoteError`. `defineRemoteMethod` rejects a result that does not match its
   schema.
5. **Limits and lifecycle.**
   - The upgrade after `maxConnections` gets `503` with `Retry-After`. With
     `maxConnections: 1`, an upgrade that fails the gate releases its slot, so
     the next good upgrade succeeds.
   - A second `installWebSocket` on one app throws.
   - Captured logs never hold the `bearer.` token, a pinned header or a body.
   - Upgrade 17 from one client key gets `429` while another client connects.
   - Call 33 gets `data.statusCode: 429`, and so does a call past
     `maxInFlightTotal`.
   - With `tools.rateLimit`, the call after the limit gets `-32029` with
     `data: {code: 'rate_limited', retryAfterSecs}`. With one Redis store and
     `keyPrefix` shared with `/mcp`, calls on both surfaces count against one
     principal. `/mcp`'s existing rate-limit tests stay green after the move.
   - A notification over `maxInFlight` is dropped and counted in
     `stats().droppedNotifications`.
   - A client that sends calls without reading replies is paused once
     `bufferedAmount` passes `pauseBytes`, and closed with `1008` past
     `closeBytes`.
   - A `tool.call` result over `maxResponseBytes` gives the `413` error.
   - `stats()` changes on open, call, drop and close.
   - A usage event for a carried tool has `transport: 'ws'`; the same call over
     `/mcp` has `transport: 'http'`.
   - `app.stop()` during an in-flight call aborts its signal, waits for it, and
     then closes with `1001`; the connection context is closed after any
     disconnect.
   - `uninstall()` closes every connection with `1001`. A second `uninstall()`
     does nothing, checked against state that two holders share.
6. **Install conformance.** `runInstallConformance` in `@agentback/testing`
   gets a WebSocket-aware probe kind: an `upgrade` probe succeeds while the
   helper is installed and gets `404` after `uninstall()`. The `installWebSocket`
   conformance test uses it with `hosts: ['express']` and `reinstall: false`,
   because `upgrade()` refuses a path after `start()`, and a fetch host cannot
   upgrade. The probe offers `agentback.jsonrpc.v0`.
7. **Typed client (`createWsClient`).** It calls `tool`, answers a server
   request through `handle` registered before `connect()` (including one sent
   during `onConnect`), rejects a reply that does not match the
   `defineRemoteMethod` schema, replies `-32601` to a method with no handler,
   rejects pending calls with `WsAuthExpiredError` on `4401`, rejects
   `connect()` with `WsUpgradeRefusedError` (status + envelope) on a 403 when
   the constructor is `ws`, throws locally for a non-`tchar` token, and throws
   naming `ws` when `headers` come without a constructor that takes options. A
   browser bundle of `@agentback/client` contains no `ws` import.
8. **Test client.** `createTestApp(App, {ws: {path, protocols?, headers?}})`
   connects a `createWsClient` instance eagerly and returns it as `.ws`.
   `@agentback/ws` and `ws` are optional peers of `@agentback/testing`, like
   `@agentback/mcp`. The test client uses `ws`, because Node's global
   `WebSocket` cannot set headers. A test drives `tool.call` and one server
   request through it.
9. **Mutation checks.** Remove each of these guards from `dist/` and confirm
   that a test fails: the try/catch around message dispatch, the visibility
   check on `tool.call`, the gate re-run, `noLocalPrincipal`, the Origin check,
   the per-client slot release, the `maxInFlight` bypass for cancel and ping,
   and the upgrade deadline.

## 6. Risks

- **Gate cost.** The gate re-runs before every call. With RFC 7662
  introspection (`authentication-oauth2`) that is a network round trip per call
  and per server request. An app with that strategy should enable the
  strategy's own caching; the design does not add a second cache. The guide's
  auth section states the cost and shows the caching recipe.
- **New defaults are estimates.** The upgrade deadline, the in-gate cap, the
  server-wide in-flight cap and the 5 s shutdown wait have no measured basis
  yet. Phase 1 states them as estimates and revisits them with the first
  consumer's numbers.
- **A second Origin policy.** `/mcp` and `/ws` now have different Origin rules.
  Each rule is documented beside its mount, §2 records why they differ, and
  the table below is linked from both mounts' docs.
- **A third strategy chain.** `/ws` runs the strategy chain with one deliberate
  difference from `/mcp`. A shared `runStrategyChain` would keep the copies
  from drifting; it is a follow-up because it changes the `/mcp` guard (§7).

| Rule                                    | `/mcp` (stateless)       | `/ws`                                          |
| --------------------------------------- | ------------------------ | ---------------------------------------------- |
| Origin, no `rest.cors`                  | localhost hostnames only | same origin; localhost only on a loopback host |
| Origin, exact CORS strings              | exact match              | exact match                                    |
| `Origin: null`                          | not listed               | `403`                                          |
| Scopes, gate configured, anonymous      | `[]`                     | `[]`                                           |
| Scope derivation                        | `principalScopes`        | `principalScopes`                              |
| `localPrincipal` for a remote caller    | refused                  | refused (`noLocalPrincipal`)                   |
| Bad credentials under `required: false` | anonymous                | `401`                                          |
| `anonymous` strategy in the chain       | allowed                  | refused at install                             |

## 7. Sequencing

1. **Tools, server requests, the client, the docs and the example.**
   `@agentback/ws` with §3.1–§3.8 complete, every §3.7 item, `createWsClient`
   (§3.8), and the tests in §5. Phase 1 also ships every doc surface the repo
   requires for a new package, in the same change:
   - `packages/ws/README.md`, which states "Node only" and "experimental
     protocol" before the install instructions;
   - a `docs/packages.md` row and a `docs/README.md` link;
   - `docs/guides/websocket.md`, with four entry points: "first server
     request", "authentication" (incl. the per-call gate cost and the caching
     recipe), "disconnects and errors" (the troubleshooting table, `4401`,
     refused upgrades, process-local registry lookups, the
     `DEBUG=agentback:ws:*` section) and "API reference";
   - a protocol reference with copy-paste frames: a server request and its
     reply, `notifications/cancelled`, a client JSON-RPC error, and a raw
     browser snippet without `createWsClient`;
   - `skills/agentback/SKILL.md` routing and
     `skills/agentback/references/websocket.md`;
   - a CLAUDE.md package entry;
   - `examples/hello-ws`: it **leads with one typed server request** (no
     tools), then adds one `@tool`; a Node client script and a browser page;
     `pnpm -F hello-ws start` prints the round trip and the answered server
     request; a small `stats()` route; and a test that runs in CI.
2. **Carried routes.** `http.request` and `http.stream` per §3.9, with the four
   `@agentback/rest` items, the phase-2 client methods and tests, and an
   Express-vs-native capability matrix in the guide (rate-limit parity, remote
   address, forwarded headers, TLS). Phase 2 starts when a consumer needs REST
   over a socket.
3. **Route descriptors and AsyncAPI.** `@agentback/client` gets a WebSocket
   transport option, so the existing `defineRoute` descriptors work over a
   connection as well as over `fetch`. This phase also emits AsyncAPI 3 for the
   server requests that OpenAPI cannot describe (Zod `toJSONSchema` with
   `target: 'draft-07'`).

Phases 4 to 6 are roadmap. This design does not review them.

4. **Edge hosts.** A fetch-host path that returns `101`: `WebSocketPair` on
   Workers, the `websocket` option of `Bun.serve`, and `Deno.upgradeWebSocket`.
5. **Rooms.** Topics over an `EventBus` backplane, so `WsBindings.REGISTRY` can
   reach connections in other processes. Event push from
   `ActorRegistry.subscribe`.
6. **Durable Objects.** WebSocket hibernation in `actors-do`.

**Follow-ups that are not phases:**

- `confirm:` tools and eliciting tools over a connection, with server requests
  for the questions;
- priced tools over a connection, with a per-call payment field;
- progress relay for streaming `@tool`s;
- streaming from the client to the server;
- a WebSocket `EventDelivery` for MCP Events;
- a console "Connections" panel that reads `REGISTRY.stats()`;
- a shared `runStrategyChain` for `/mcp` and `/ws`;
- registration after `start()` in `upgrade()`;
- several `installWebSocket` paths on one app, with different gates.

## 8. Decisions made in review

The `/autoplan` review (CEO, DX and Eng phases, 2026-10-14 to 2026-10-17)
settled the questions that the first draft left open:

- **v1 scope.** Tools, typed server requests and the client ship first; carried
  routes are phase 2 (§3.9).
- **Cancellation and backpressure through `light-my-request`.** The first draft
  planned to measure them in phase 1. Reading the library's source answered
  both: its `signal` option does not cancel a route that read its body, and the
  REST stream sink does not wait under injection. §3.9 gives the designs.
- **Limiter home.** `createToolRateLimiter` moves to `@agentback/mcp`.
- **Strategy chain.** An `anonymous` strategy in the chain is refused at
  install.
- **Re-authentication.** No re-check interval option; a connection closes at
  its credential's own expiry (§3.3).
- **Upgrade refusals** stay before `101` and are made diagnosable (§3.3).

The only open measurements are in phase 2: the injection overhead (the 2× stop
rule) and lazy pulling of `Response.body` on the native host (§3.9).

## 9. Out of scope

- MCP over WebSocket (the spec defines no such transport).
- Streaming from the client to the server. No input-stream primitive exists in
  `@api` or `@tool` to carry it. It is a follow-up (§7).
- Socket.IO protocol compatibility and long-polling fallback.
- Batches, binary frames and multipart request bodies.
- MCP resources and prompts.
- Exactly-once delivery.

The raw `upgrade()` hook stays the escape hatch for all of these.
