# @agentback/mcp-client

Connect to a remote MCP server over Streamable HTTP — including OAuth-protected
ones — and get the SDK `Client` back. A thin, dependency-light wrapper over the
official `@modelcontextprotocol/sdk` client transport, with bearer-token
injection and transparent 401 refresh-retry.

## Usage

```ts
import {connectMcp} from '@agentback/mcp-client';

// Unauthenticated server
const {client} = await connectMcp({url: 'https://api.example.com/mcp'});
await client.listTools();
await client.callTool({name: 'add', arguments: {a: 2, b: 40}});
```

### OAuth-protected servers

```ts
// "I already have a token" — the common server-to-server case. The getter is
// re-called on a 401 so an expired token is refreshed and the request retried.
const {client} = await connectMcp({
  url: 'https://api.example.com/mcp',
  bearerToken: () => tokenStore.getAccessToken(),
});

// Interactive authorization-code / PKCE flow — bring your own provider; the SDK
// drives discovery + token exchange.
const {client} = await connectMcp({url, authProvider: myOAuthClientProvider});
```

| option             | meaning                                                       |
| ------------------ | ------------------------------------------------------------- |
| `url`              | the server's Streamable HTTP endpoint                         |
| `bearerToken`      | token or `() => string \| Promise<string>` (re-called on 401) |
| `authProvider`     | full OAuth flow — an SDK `OAuthClientProvider`                |
| `fetch`            | custom `FetchLike` (advanced; overrides `bearerToken`)        |
| `requestInit`      | extra request init (headers, …)                               |
| `name` / `version` | client identity sent during `initialize`                      |

`bearerFetch(tokenOrGetter)` is exported standalone if you want the
Authorization-injecting, 401-retrying `fetch` wrapper for other uses.

### Interactive OAuth (login flow)

For servers that require a full OAuth login (Notion, GitHub's hosted MCP, …),
`LoopbackOAuthProvider` + `startOAuth`/`finishOAuth` drive the SDK's `auth()`
flow end to end — RFC 9728 discovery, RFC 7591 dynamic client registration (or a
pre-registered client), PKCE, the authorization-code redirect, token exchange,
and refresh.

```ts
import {
  LoopbackOAuthProvider,
  startOAuth,
  finishOAuth,
  connectMcp,
} from '@agentback/mcp-client';

const provider = new LoopbackOAuthProvider({
  redirectUrl: 'https://my-app.example.com/oauth/callback', // a route you serve
  clientName: 'My App',
  scope: 'mcp',
});

// 1. Begin: discover + register + build the authorization URL.
const begin = await startOAuth(provider, 'https://mcp.example.com/mcp');
if (begin.status === 'redirect') {
  // 2. Send the user to begin.authorizationUrl; the AS redirects back to
  //    redirectUrl with ?code=&state=. Then:
  await finishOAuth(provider, 'https://mcp.example.com/mcp', codeFromCallback);
}

// 3. Connected — the provider holds (and refreshes) the tokens.
const {client} = await connectMcp({
  url: 'https://mcp.example.com/mcp',
  authProvider: provider,
});
```

Token/client/PKCE state lives in a pluggable `OAuthStore` (default in-memory).
This is the engine behind the MCP Inspector's "connect with OAuth" mode
([`@agentback/mcp-inspector`](../mcp-inspector)).

## Why no codegen

The client speaks MCP — discovery (`tools/list`) is dynamic — so there's nothing
to generate. For typed **REST** consumers that share Zod schemas, use
[`@agentback/client`](../client) instead.
