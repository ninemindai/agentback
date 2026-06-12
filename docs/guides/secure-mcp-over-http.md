# Secure MCP over HTTP

`installMcpHttp(app)` exposes your `@tool`/`@resource`/`@prompt` surface to
remote MCP clients (Claude, Cursor, agents) at `/mcp`. That is a remotely
callable RPC endpoint into your process — this guide is the production
checklist for it.

The threat model in one paragraph: an unauthenticated `/mcp` lets anyone who
can reach the port enumerate and call your tools; a browser-reachable one is
additionally exposed to DNS-rebinding (a malicious web page POSTing JSON-RPC
to `http://localhost`). The defenses below layer: transport auth decides
_who_ is calling, `@authorize`/scopes decide _what they see and may call_,
and the hardening options bound the blast radius.

## Step 1 — pick an authentication mode

### Option A: framework strategies (`strategyAuth`)

Reuse the same `@agentback/authentication` strategies that protect your
REST routes — JWT, API key, client-credentials — so both surfaces share one
identity system:

```ts
import {installMcpHttp} from '@agentback/mcp-http';

await installMcpHttp(app, {
  strategyAuth: {
    strategy: ['api-key', 'jwt'], // first that authenticates wins
    required: true, // 401 when none does (the default)
  },
});
```

The authenticated principal's `scopes` (or a client application's
`allowedScopes`) become the session's MCP scopes; override the mapping with
`strategyAuth.scopes: auth => string[]`. This is the right mode when your
callers already hold credentials you issued.

### Option B: OAuth 2.1 resource server (`auth`)

For third-party MCP clients that discover authorization dynamically (the MCP
auth spec flow), make `/mcp` a protected resource. The framework is the
**resource server only** — bring your own authorization server (Auth0,
Clerk, WorkOS, Keycloak, your own) and a token verifier:

```ts
import {createRemoteJWKSet, jwtVerify} from 'jose';

const jwks = createRemoteJWKSet(
  new URL('https://auth.example.com/.well-known/jwks.json'),
);

await installMcpHttp(app, {
  auth: {
    resource: 'https://api.example.com/mcp',
    authorizationServers: ['https://auth.example.com'],
    requiredScopes: ['mcp:use'],
    verifier: {
      verifyAccessToken: async token => {
        const {payload} = await jwtVerify(token, jwks, {
          audience: 'https://api.example.com/mcp',
        });
        return {
          token,
          clientId: String(payload.client_id ?? payload.azp ?? ''),
          scopes: String(payload.scope ?? '')
            .split(' ')
            .filter(Boolean),
          expiresAt: payload.exp,
        };
      },
    },
  },
});
```

With `auth:` set, every request must carry `Authorization: Bearer <token>`;
the endpoint serves `/.well-known/oauth-protected-resource` (RFC 9728) and
challenges unauthenticated requests so compliant clients discover your AS
and start the OAuth flow on their own. Verify the **audience**: a token
minted for another resource must not open yours.

The two modes compose — `auth` for external OAuth clients alongside
`strategyAuth` for first-party API keys.

## Step 2 — scope the tool surface per caller

Authentication answers "who"; the policy layer answers "what". One
`@authorize` declaration governs both REST and MCP:

```ts
@authorize({scopes: ['orders:write']})
@tool('refund_order', {input: RefundIn, output: RefundOut})
async refund(input: z.infer<typeof RefundIn>) { … }
```

On an authenticated transport, scope-gated tools are **invisible** in
`tools/list` to sessions lacking the scope (gated at session construction,
not just at call time), and denied on `tools/call` regardless. The same
applies to `@resource` and `@prompt` members. Roles/voter-gated members stay
listed and are denied at call time — voters need a live request to vote.

Inside a tool, the verified identity is injectable:

```ts
@tool('whoami')
async whoami(@inject(MCPBindings.REQUEST_AUTH, {optional: true}) auth?: AuthInfo) {
  return {clientId: auth?.clientId, scopes: auth?.scopes};
}
```

One subtlety worth knowing: `MCPServerConfig.localPrincipal` is the ambient
identity for **unauthenticated transports** (stdio, the inspector). It is a
development convenience — do not configure a privileged `localPrincipal` on
an app that also exposes `/mcp` without auth, or every remote caller
inherits it.

## Step 3 — harden the endpoint

```ts
await installMcpHttp(app, {
  strategyAuth: {strategy: 'jwt'},
  // DNS-rebinding defense: reject requests whose Host/Origin aren't yours.
  allowedHosts: ['mcp.example.com'],
  allowedOrigins: ['https://app.example.com'],
  // Per-tool, per-caller rate limits for tools/call.
  rateLimit: {
    points: 60,
    durationSecs: 60,
    perTool: {expensive_search: {points: 5, durationSecs: 60}},
  },
});
```

- **DNS rebinding**: setting `allowedHosts`/`allowedOrigins` enables the
  protection automatically. The permissive default exists only so local dev
  works out of the box — production deployments should always set the
  allowlists.
- **Rate limiting** is per tool and per caller, so one chatty agent can't
  starve the rest. (The in-memory limiter is per-process; see the
  multi-instance checklist in
  [Deploy to production](deploy-to-production.md).)
- **Resumable sessions**: pass an `eventStore` only if you need SSE-replay
  across reconnects; a shared (Redis) store is required for it to work
  behind a load balancer.

## Step 4 — verify what a session actually sees

The cheapest audit is the framework's own test harness: boot the app with a
given scope set and assert the visible tool list.

```ts
await using t = await createTestApp(MyApp, {mcpScopes: ['orders:read']});
const {tools} = await t.mcp.listTools();
expect(tools.map(x => x.name)).not.toContain('refund_order');
```

This exercises the same session-construction path as an authenticated HTTP
caller — if the test can't see a tool, neither can a token with those
scopes.

## Checklist

- [ ] `strategyAuth` or `auth` configured; anonymous `/mcp` is a deliberate
      decision, not a default you forgot.
- [ ] OAuth `verifier` checks signature, expiry, **and audience**.
- [ ] Dangerous tools carry `@authorize({scopes})` (invisible without the
      scope) and, where appropriate, `confirm: true`.
- [ ] `allowedHosts`/`allowedOrigins` set.
- [ ] Per-tool rate limits for expensive tools.
- [ ] No privileged `localPrincipal` on an HTTP-exposed app.
- [ ] A scope-visibility test per sensitive tool.
