# @agentback/mcp-connect

Connect to **remote** MCP servers (Notion, GitHub, Linear, your own…) from a
AgentBack app and proxy their tools / resources / prompts over a small JSON
API — including the full interactive **OAuth 2.1** handshake (RFC 9728 discovery
→ RFC 7591 dynamic client registration → PKCE → authorization-code redirect →
token refresh).

This is the connection + auth engine behind the mcp-inspector's "remote" mode.
It owns the persistent MCP client connections so a UI stays a thin consumer of
its endpoints.

```ts
import {RestApplication} from '@agentback/rest';
import {installMcpConnect} from '@agentback/mcp-connect';

const app = new RestApplication();
const registry = await installMcpConnect(app); // mounts /mcp-connect/api + OAuth callback
await app.start();
```

## What it mounts

Under `path` (default `/mcp-connect`), with the JSON API under `<path>/api`:

| Method & route                             | Purpose                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `GET  <api>/targets`                       | List connected/authorizing targets                                    |
| `POST <api>/targets`                       | Add a target: `{url, auth}` (see below)                               |
| `DELETE <api>/targets/:id`                 | Disconnect + forget a target                                          |
| `GET  <api>/targets/:id/manifest`          | The remote's tools/resources/prompts + server info                    |
| `POST <api>/targets/:id/tools/:name/call`  | Invoke a tool (body = arguments)                                      |
| `POST <api>/targets/:id/resources/read`    | Read a resource (body = `{uri}`)                                      |
| `POST <api>/targets/:id/prompts/:name/get` | Fetch a prompt                                                        |
| `GET  <path>/oauth/callback`               | OAuth redirect target; `postMessage`s the opener and closes the popup |

### Auth modes (the `auth` field on `POST /targets`)

```ts
{type: 'none'}
{type: 'bearer', token: '…'}
{type: 'oauth', scope?, clientId?, clientSecret?, resource?: string | false}
```

For `none`/`bearer` the connection is established immediately and the response is
`{id, status: 'connected'}`. For `oauth` the response is
`{id, status: 'authorize', authorizationUrl}` — open `authorizationUrl` in a popup;
the authorization server redirects back to `<path>/oauth/callback`, which calls
`registry.completeOAuth(state, code)` and signals the opener via `postMessage`
(`{source: 'mcp-connect', type: 'oauth-complete', ok}`).

`resource: false` opts out of the RFC 8707 resource-indicator match check — use
it when a server advertises a `resource` in its metadata that differs from the
URL you connect to.

## Using the registry directly

`installMcpConnect` returns the {@link RemoteRegistry}; you can also drive it
without the HTTP mount: `addTarget`, `source(id)` (a `RemoteSource` with
`manifest()`, `callTool()`, `readResource()`, `getPrompt()`), `completeOAuth`,
`remove`, `closeAll`.

> **Teardown note:** a target holds a long-lived client (with a standalone SSE
> stream) to the remote server. Call `registry.closeAll()` (or `remove(id)`)
> before shutting down so connections drain cleanly.

## Security: SSRF

`POST /targets` makes the **server** open a connection to a caller-supplied URL
— a Server-Side Request Forgery surface. Mitigations:

- **Default-deny private targets.** Out of the box the registry rejects URLs
  that are (or DNS-resolve to) loopback, link-local (incl. the
  `169.254.169.254` cloud-metadata endpoint), RFC1918, CGNAT, or other reserved
  ranges — checking **every** resolved address — and rejects non-`http(s)`
  schemes. The same guard wraps the OAuth discovery / token / registration
  fetches. Pass `allowPrivateTargets: true` (to `installMcpConnect` or the
  registry) only for trusted deployments or local development against
  `localhost` servers.
- **Gate the API behind auth.** mcp-connect does not authenticate its own
  routes; put your app's auth middleware in front of `<path>` so untrusted
  users can't trigger outbound requests. In production, also restrict the
  server's outbound network egress.
- **Don't expose these routes with permissive CORS.** mcp-connect adds no CORS
  of its own (the RestServer default is CORS-off), and the endpoints require a
  `application/json` body — so a cross-origin POST triggers a preflight. But if
  you set `RestServer`'s `cors: true` (which is `origin: '*'`) globally, any web
  page in a user's browser could drive `/targets` (SSRF) and invoke tools on
  already-connected targets (a confused-deputy with the user's OAuth creds). If
  you need CORS elsewhere, scope it to trusted origins and don't let it cover
  `<path>`.
- **OAuth popup messaging is origin-scoped.** The callback page `postMessage`s
  its result to the inspector's own origin (not `*`), and the inspector ignores
  messages whose `event.origin` isn't its own.
- **Residual risk:** the guard validates at request time and does not pin the
  resolved IP, so DNS-rebinding after the check or an HTTP redirect to an
  internal URL are not fully covered by the guard alone — auth + egress
  controls close that gap.

Built on [`@agentback/mcp-client`](../mcp-client) (the SDK `Client`,
`connectMcp`, and the `LoopbackOAuthProvider`).
