# @agentback/mcp-http

Expose an application's in-process MCP server over the MCP **Streamable HTTP**
transport, mounted on the `RestApplication`'s Express app. The same
`@tool`/`@resource`/`@prompt` surface that runs over stdio becomes reachable by
remote MCP clients (Claude, Cursor, agents) — with per-session isolation.

> Kept as a separate package so `@agentback/mcp` stays lean (no Express
> dependency) for stdio-only use. Mirrors how `rest-explorer` / `mcp-inspector`
> are separate install packages.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';

const app = new RestApplication();
app.component(MCPComponent);
app.service(MyTools); // @mcpServer() class with @tool/@resource/@prompt
await installMcpHttp(app); // before app.start()
await app.start();
// POST   /mcp   — client → server JSON-RPC (initialize, tools/list, tools/call, …)
// GET    /mcp   — SSE stream for server → client messages on a session
// DELETE /mcp   — terminate a session
```

Options:

| option                         | default | meaning                                                                   |
| ------------------------------ | ------- | ------------------------------------------------------------------------- |
| `path`                         | `/mcp`  | URL path the transport is mounted at                                      |
| `allowedHosts`                 | —       | allowlist of `Host` header values                                         |
| `allowedOrigins`               | auto¹   | allowlist of `Origin` header values                                       |
| `enableDnsRebindingProtection` | auto¹   | reject requests with non-allowlisted Host/Origin                          |
| `eventStore`                   | —       | enable resumable sessions (see below)                                     |
| `auth`                         | —       | OAuth 2.1 resource-server protection (see below)                          |
| `strategyAuth`                 | —       | authenticate `/mcp` with framework auth strategies (see below)            |
| `rateLimit`                    | —       | per-tool, per-caller rate limiting for `tools/call` (see below)           |
| `perSession`                   | —       | per-user/per-tenant tool _discovery_ via a session DI context (see below) |

¹ On the default (stateless) mount an `Origin` allowlist is always derived, so
protection is **on**; see below. Under `protocol: 'legacy'` it stays `true` only
when `allowedHosts` or `allowedOrigins` is set.

### Security: DNS rebinding

A browser-reachable MCP endpoint is a DNS-rebinding target — a malicious page
can POST to it from the user's machine. Every Streamable HTTP revision since
`2025-03-26` says servers **MUST** validate `Origin` for exactly this reason, so
the default mount validates it whether or not you configure an allowlist.

What it validates when you configure nothing:

| `rest.cors`                             | derived `Origin` allowlist                                   |
| --------------------------------------- | ------------------------------------------------------------ |
| not set                                 | localhost only                                               |
| `{origin: ['https://app.example.com']}` | localhost + `app.example.com`                                |
| `true`, `'*'`, a RegExp or a callback   | nothing derivable — **logs a warning**, validation stays off |

The allowlist is derived from `rest.cors` because those origins are already your
statement of which browsers may call the app — declaring them twice is a second
source of truth that drifts. When CORS admits _any_ origin there is nothing to
enumerate, so it warns instead of guessing: restricting to localhost there would
break the browser client your own config admits.

One exception: if you pass `enableDnsRebindingProtection: true` **explicitly**
and nothing is derivable, it falls back to localhost rather than enforcing
nothing. An explicit `true` should never be a silent no-op.

**A missing `Origin` header always passes.** Only browsers send one, so MCP
clients, `curl` and stdio bridges are unaffected — the default can only reject a
browser request, which is the case being defended.

A rejection answers `403` with a body that names `allowedOrigins` and `rest.cors`,
so whoever is looking at the failed request can fix it without server logs (the
framework's `loggers` are `debug`-namespaced and emit nothing unless `DEBUG` is
set). The full allowlist goes to the log, deduplicated per origin.

Pin the allowlists explicitly in production; an explicit value always wins, and
`enableDnsRebindingProtection: false` opts out entirely:

```ts
await installMcpHttp(app, {
  allowedHosts: ['mcp.example.com'],
  allowedOrigins: ['https://app.example.com'],
});
```

⚠️ **`Origin` values are compared by hostname only** on the stateless mount —
scheme and port are ignored. `https://app.example.com` therefore also admits
`https://app.example.com:8443` **and `http://app.example.com`**. That is the
SDK's `validateOriginHeader` semantics, and it applies to values you configure
explicitly as well as derived ones — so a precise CORS grant becomes a
whole-hostname grant. It still blocks the case the guard exists for (a
different host, which is what DNS rebinding produces), but if you need
scheme-exact policy, enforce it at your proxy. `Origin: null` (sandboxed
iframes, opaque origins) is always rejected.

For a localhost-only server, set `allowedHosts: ['127.0.0.1:PORT', 'localhost:PORT']`.

`installMcpHttp` throws if no MCP server is bound (add `MCPComponent` first).
For a non-`RestApplication` Express app, use `mountMcpHttp(mcpServer, expressApp, opts)`.

## Protocol: stateless (default) or sessions

`protocol` picks how the endpoint serves MCP. **The default is `'both'` as of
0.9.0** — you get the `2026-07-28` revision without asking, and 2025-era clients
keep working from the same URL.

|                              | `'both'` (default)                   | `'legacy'`             |
| ---------------------------- | ------------------------------------ | ---------------------- |
| Protocol revision            | **2026-07-28 + 2025, same endpoint** | 2025-era only          |
| `Mcp-Session-Id`             | none                                 | minted on `initialize` |
| `GET` / `DELETE` on `/mcp`   | `405` (session ops)                  | SSE stream / terminate |
| Server instance              | one per **request**                  | one per session        |
| `eventStore` (resumable SSE) | not applicable — see below           | supported              |
| `perSession` binder          | once per **request** (see below)     | once per session       |
| Scaling                      | plain round-robin, no shared storage | needs session affinity |

Both hosts support both: the Express mount adapts the SDK's web-standards-only
handler with `toNodeHandler`, the fetch/edge mount uses it directly.

### Why the default flipped, and how to undo it

`'both'` serves 2025-era clients **by construction**, so this is not a drop in
client support — it is verified against three released 1.x SDKs (1.11.0 /
1.17.0 / 1.29.0, covering every 2025 revision) on top of the current client.

The rollback is one line, with nothing else to change:

```ts
await installMcpHttp(app, {protocol: 'legacy'});
// or once, app-wide — this mount inherits it:
app.configure('servers.MCPServer').to({protocol: 'legacy'});
```

When this mount does not state a `protocol`, it **inherits the `MCPServer`
config's**, so pinning the app back rolls back stdio and `/mcp` together. An
explicit value here still wins, for the genuinely mixed case. (`eventStore`
without a protocol still yields to sessions — see below.)

Two things do change under the default, because sessions are gone:

⚠️ **`perSession` now runs on every request.** If your binder does an
entitlement lookup, wrap it in [`cachedPerPrincipal`](#caching-a-per-request-binder)
or that lookup starts tracking request volume.

⚠️ **`eventStore` (resumable SSE replay) needs a session.** Rather than let the
new default silently delete it, setting `eventStore` **without** naming a
protocol keeps the endpoint on `'legacy'` and logs why. An explicit
`protocol: 'both'` alongside it warns and drops resumability — naming the
protocol is always decisive.

Under `'both'` each request builds its own server and its own DI context,
released when the SDK closes that request's server — after any streamed
progress, so streaming tools are unaffected.

Stdio has the same switch and the same default — see
[`@agentback/mcp`](../mcp/README.md).

## Caching a per-request binder

`cachedPerPrincipal` caches the expensive **lookup**, not the context:

```ts
import {cachedPerPrincipal} from '@agentback/mcp-http';
import {addTool} from '@agentback/mcp';

await installMcpHttp(app, {
  protocol: 'both',
  perSession: cachedPerPrincipal(
    principal => entitlements.toolsFor(principal?.extra?.sub), // cached
    (ctx, classes) => classes.forEach(C => addTool(ctx, C)), // every request
    {
      // REQUIRED. This key is a security boundary, so the framework will not
      // guess it. Do NOT use `clientId`: under OAuth that is the client
      // APPLICATION id, shared by every end user of that app.
      keyOf: p => `${p?.extra?.sub ?? 'anon'}|${[...(p?.scopes ?? [])].sort()}`,
      ttlMs: 60_000,
    },
  ),
});
```

`apply` runs fresh per request against that request's own context. **Never cache
a `Context`** — it is closed when its request ends.

`keyOf` is **required**, deliberately: the key decides which tools a caller
sees, so it is a security boundary the framework will not guess. Do **not** key
on `AuthInfo.clientId` — under OAuth that is the client _application_ id, shared
by every end user signing in through it, so two users would share one entry.
Key on the claim your IdP uses for the subject (often `extra.sub`), plus granted
scopes so a re-issued narrower token cannot reuse a wider answer.

`ttlMs` is your **entitlement-revocation window**, not a latency knob: a revoked
principal keeps the old answer until the entry expires. Failed lookups are not cached, and concurrent cold requests for one
principal share a single in-flight lookup.

## How sessions work

Each MCP session gets its **own** underlying SDK server (`mcp.buildServer()`)
connected to one `NodeStreamableHTTPServerTransport`, keyed by the `Mcp-Session-Id`
header. This is required because a single `McpServer` can only be connected to
one live transport at a time; per-session servers keep concurrent clients
isolated (all exposing the same tool surface). A `POST` with an unknown session
id returns `404`; an initialize request (no session) mints a new one.

## Connecting a client

```ts
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const client = new Client({name: 'my-client', version: '1.0.0'});
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://host:port/mcp')),
);
await client.listTools();
await client.callTool({name: 'add', arguments: {a: 2, b: 40}});
```

## Browser clients (CORS)

A browser MCP client's traffic to `/mcp` is **always** preflighted — `content-type:
application/json`, `MCP-Protocol-Version`, `Mcp-Session-Id` and `Authorization`
are all non-simple headers. `/mcp` is deliberately _not_ open-CORS (unlike the
public `/.well-known/oauth-protected-resource` discovery document, which is
unauthenticated by design), so who may call it stays your decision:

```ts
new RestApplication({rest: {cors: true}}); // or a CorsOptions object
```

Without it, `curl` works and the browser client fails with no error that
mentions CORS. That is the single most confusing way to hit this.

`installMcpHttp` adds `Mcp-Session-Id` to `Access-Control-Expose-Headers` on the
session path automatically. Under CORS a response header is invisible to JS
unless it is named there, and the session id is the one header the client must
read and echo back — without it, `initialize` succeeds, the client never sees
the id, and its next call is answered _"no active MCP session"_. This is not an
access grant: `Access-Control-Allow-Origin` still decides who may read anything,
so the header is inert until you configure `cors`.

Under `protocol: 'both'` there is no session id at all, so plain `cors: true` is
the whole story.

## Resumable sessions

Pass an `eventStore` to replay missed events when a dropped SSE stream reconnects
with `Last-Event-ID`. The bundled `InMemoryEventStore` suits a single process;
implement `EventStore` over a shared store (e.g. Redis) for multi-instance.

```ts
import {installMcpHttp, InMemoryEventStore} from '@agentback/mcp-http';
await installMcpHttp(app, {eventStore: new InMemoryEventStore()});
```

Per-request tool identity: when `auth` is configured, a `@tool` handler can
inject the caller's auth via `@inject(MCPBindings.REQUEST_AUTH, {optional: true})`.

## OAuth (resource server)

Pass `auth` to protect `/mcp` as an OAuth 2.1 **resource server**. Every request
must carry a valid `Authorization: Bearer <token>`; the endpoint advertises
`/.well-known/oauth-protected-resource` (RFC 9728) and challenges unauthenticated
requests with `WWW-Authenticate` so compliant clients discover the authorization
server. The framework is a resource server — **bring your own AS** (Clerk, Auth0,
WorkOS, your own) and provide a `verifier` that validates its tokens.

```ts
await installMcpHttp(app, {
  auth: {
    // Validate the bearer token (typically a JWT against the AS's JWKS) and
    // return its scopes/clientId. Throw an InvalidTokenError to reject.
    verifier: {
      async verifyAccessToken(token) {
        const claims = await verifyJwtAgainstJwks(token); // your impl
        return {
          token,
          clientId: claims.azp,
          scopes: (claims.scope ?? '').split(' '),
          expiresAt: claims.exp, // required by the SDK
        };
      },
    },
    resource: 'https://api.example.com/mcp',
    authorizationServers: ['https://auth.example.com'],
    scopesSupported: ['mcp:tools', 'admin'],
  },
});
```

### Scope-based tool ACL

Tag a tool with a required scope; a session only sees and can call tools whose
scope the caller's token holds (tools without a `scope` are always available):

```ts
@tool('delete_thing', {input: DeleteIn, scope: 'admin'})
async deleteThing(input) { … }
```

Filtering happens by construction — each session's server is built with only the
permitted tools — so both `tools/list` and `tools/call` are gated. Scope ACL
applies only when `auth` (or `strategyAuth`, below) is configured.

## Framework-strategy auth

Instead of (or alongside) the SDK OAuth `auth`, authenticate `/mcp` with the
**same `@agentback/authentication` strategies as REST** — `jwt`, `api-key`,
`client-credentials`, `anonymous`, or your own. The authenticated principal's
scopes drive the per-session tool ACL, and the principal is bound for tool
injection (`MCPBindings.REQUEST_AUTH`), so MCP tools authenticate exactly like
REST routes.

```ts
import {
  ApiKeyAuthenticationStrategy,
  API_KEY_VERIFIER,
} from '@agentback/authentication';

app
  .bind(API_KEY_VERIFIER)
  .to(async key => /* … */ ({[securityId]: 'svc', scopes: ['mcp:tools']}));
app
  .bind('strategies.apiKey')
  .toClass(ApiKeyAuthenticationStrategy)
  .tag(AuthenticationBindings.AUTH_STRATEGY);

await installMcpHttp(app, {
  strategyAuth: {strategy: ['api-key', 'jwt']}, // tried in order; 401 if none
});
```

Scopes are derived from the principal's `scopes` (user) or `allowedScopes`
(client application) — override with `strategyAuth.scopes(auth)`. Set
`required: false` for optional auth (anonymous sessions still get an unscoped
tool set). `installMcpHttp` supplies the DI `context` automatically; pass it
explicitly to `mountMcpHttp`.

## Per-session tools (per-user / per-tenant discovery)

Scope ACL (above) **filters** a fixed, global tool set. `perSession` goes
further: it lets different sessions _discover **different tools**_ — a tool that
exists for one user and **does not exist** (no name, no schema in `tools/list`)
for another. Use it for multi-tenant surfaces, per-user plugins, or tools
synthesized from the caller's account.

Each new session gets its own DI context (parented on the app). Your binder
populates it; the session's `MCPServer` then discovers the shared app-level tools
**plus** whatever the binder added. Register session-local tool classes with
`addTool(ctx, ToolClass)` — the session-scoped counterpart to `app.service(...)`.

```ts
import {addTool} from '@agentback/mcp';
import type {AuthInfo} from '@agentback/mcp-http';

await installMcpHttp(app, {
  auth: {verifier /* … */},
  perSession(ctx, req) {
    const principal = req.auth as AuthInfo | undefined; // validated by the guard
    if (!principal) return; // anonymous → shared tool set only
    // NOT `clientId` — under OAuth that is the client APPLICATION id.
    for (const ToolClass of entitlements.toolsFor(principal.extra?.sub)) {
      addTool(ctx, ToolClass); // discovered only for this session
    }
  },
});
```

> ⚠️ **Security — key the binder off `req.auth`, never a header.** `req.auth` is
> set by the `auth` / `strategyAuth` guards (which run before the binder) and is
> validated. A raw header (`req.headers['x-…']`) is attacker-controlled — keying
> tool discovery off one means any client can request another tenant's tools.
> The binder must mutate **only** `sessionCtx`; never reach up to the app
> context. `perSession` without `auth`/`strategyAuth` logs a warning (no
> validated principal, and scope filtering is disabled).

How it composes and behaves:

- **Composes with scope ACL** — `buildServer({scopes})` still runs on the
  per-session server, so a session-local tool can itself be `scope`-gated.
- **Register session-local tools in the binder only** — not also via
  `app.service(...)`, or the class binds twice for that session.
- **Runs once per session**, including each reconnect that mints a new session id
  (a resumed session reuses its context). Keep it cheap or cache on the principal.
- **Session→principal pinning** — when auth is on, a session is pinned to the
  principal that created it; a later request replaying its `Mcp-Session-Id` with
  a different principal gets `403`.
- **Lifecycle** — the session context is `close()`d when its transport closes
  (DELETE or disconnect) and when the app stops, so binder-bound resources are
  released. (Idle sessions that never DELETE are bounded at shutdown; a TTL
  reaper is a future addition.)
- **`mountMcpHttp`** callers must pass `appContext` (the DI root); `installMcpHttp`
  fills it automatically.

Why it works: `MCPServer` injects its own resolution context (`@inject.context()`)
and discovers tools via a chain-walking `find`, so a server resolved from a child
context sees that child's tools **and** the app's, while sibling sessions never
see each other's. See `docs/superpowers/specs/2026-06-15-session-scoped-mcp-server-design.md`.

## Per-tool rate limiting

Throttle `tools/call` over HTTP with a separate bucket per **(caller, tool)** —
keyed by the authenticated `clientId` (from `auth`/`strategyAuth`) or the client
IP. In-memory by default; pass a `store` (ioredis-compatible) to share across
instances. On exceed it returns `429` with a JSON-RPC error + `Retry-After`;
store failures fail open. Non-`tools/call` methods (initialize, `tools/list`)
are not limited. Works on **both hosts and both protocols** — the Express mount
runs it as middleware, the fetch/edge mount applies the same decision core
inline.

A batched (array) JSON-RPC body is counted **per element**, so wrapping calls in
an array does not get you extra ones.

Quota measures work performed, not requests received: on the stateless mount a
request the transport is about to refuse at its inbound validation ladder is
**not** debited. That covers a malformed JSON-RPC shape, a batch carrying
`2026-07-28` elements, and an `Mcp-Method` / `MCP-Protocol-Version` header that
disagrees with the body (`-32020 HeaderMismatch`). It matters most where the
bucket is shared: on the fetch host every anonymous caller keys to one `anon`
bucket, and a rejected batch would otherwise spend one point per element it
names while running nothing.

```ts
await installMcpHttp(app, {
  rateLimit: {
    points: 60, // default: 60 calls / 60s per tool per caller
    durationSecs: 60,
    perTool: {
      expensive_report: {points: 5, durationSecs: 60}, // tighter for one tool
    },
  },
});
```

### Choosing the bucket key

`keyGenerator` receives a host-neutral `RateLimitCaller` — `{authInfo, header(name), ip}`
— so one generator works under both mounts. Two things about the **default**
(`authInfo.clientId ?? ip ?? 'anon'`) are worth knowing before you rely on it:

- **Under OAuth, `clientId` is the client _application_ id**, shared by every end
  user signing in through that app. So the default throttles the app, not the
  user, and one noisy user starves everyone else on that client. Key on your
  IdP's subject claim for per-user limits:
  `keyGenerator: c => c.authInfo?.extra?.sub ?? 'anon'`. (On the `strategyAuth`
  path `clientId` _is_ the principal's `securityId`, so the default is per-user
  there.)
- **`ip` is `undefined` on the fetch/edge host.** There is no trustworthy source
  for it: the candidates are all `X-Forwarded-For`-style headers, and keying on a
  client-settable header means an attacker rotates it and is never limited at
  all. If your platform verifies one, read it explicitly:
  `keyGenerator: c => c.header('CF-Connecting-IP') ?? 'anon'`. Otherwise
  anonymous callers share one bucket — coarse, but it still says no.
