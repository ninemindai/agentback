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

| option                         | default | meaning                                                         |
| ------------------------------ | ------- | --------------------------------------------------------------- |
| `path`                         | `/mcp`  | URL path the transport is mounted at                            |
| `allowedHosts`                 | —       | allowlist of `Host` header values                               |
| `allowedOrigins`               | —       | allowlist of `Origin` header values                             |
| `enableDnsRebindingProtection` | auto¹   | reject requests with non-allowlisted Host/Origin                |
| `eventStore`                   | —       | enable resumable sessions (see below)                           |
| `auth`                         | —       | OAuth 2.1 resource-server protection (see below)                |
| `strategyAuth`                 | —       | authenticate `/mcp` with framework auth strategies (see below)  |
| `rateLimit`                    | —       | per-tool, per-caller rate limiting for `tools/call` (see below) |

¹ Defaults to `true` when `allowedHosts` or `allowedOrigins` is set, otherwise
`false` (so the default dev experience isn't blocked).

### Security: DNS rebinding

A browser-reachable MCP endpoint is a DNS-rebinding target — a malicious page
can POST to it from the user's machine. **Production deployments should pin the
allowlists** to the real host/origin, which turns protection on:

```ts
await installMcpHttp(app, {
  allowedHosts: ['mcp.example.com'],
  allowedOrigins: ['https://app.example.com'],
});
```

For a localhost-only server, set `allowedHosts: ['127.0.0.1:PORT', 'localhost:PORT']`.

`installMcpHttp` throws if no MCP server is bound (add `MCPComponent` first).
For a non-`RestApplication` Express app, use `mountMcpHttp(mcpServer, expressApp, opts)`.

## How sessions work

Each MCP session gets its **own** underlying SDK server (`mcp.buildServer()`)
connected to one `StreamableHTTPServerTransport`, keyed by the `Mcp-Session-Id`
header. This is required because a single `McpServer` can only be connected to
one live transport at a time; per-session servers keep concurrent clients
isolated (all exposing the same tool surface). A `POST` with an unknown session
id returns `404`; an initialize request (no session) mints a new one.

## Connecting a client

```ts
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({name: 'my-client', version: '1.0.0'});
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://host:port/mcp')),
);
await client.listTools();
await client.callTool({name: 'add', arguments: {a: 2, b: 40}});
```

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

## Per-tool rate limiting

Throttle `tools/call` over HTTP with a separate bucket per **(caller, tool)** —
keyed by the authenticated `clientId` (from `auth`/`strategyAuth`) or the client
IP. In-memory by default; pass a `store` (ioredis-compatible) to share across
instances. On exceed it returns `429` with a JSON-RPC error + `Retry-After`;
store failures fail open. Non-`tools/call` methods (initialize, `tools/list`)
are not limited.

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
