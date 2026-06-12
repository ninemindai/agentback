# Authentication, Authorization, and Rate Limiting

## Table of Contents

- [Overview](#overview)
- [Authentication](#authentication)
- [Authorization](#authorization)
- [Client-Application Scope Governance](#client-application-scope-governance)
- [How REST Wires It](#how-rest-wires-it)
- [Rate Limiting — REST](#rate-limiting--rest)
- [MCP-over-HTTP: Auth and Rate Limiting](#mcp-over-http-auth-and-rate-limiting)
- [Key Rules](#key-rules)

## Overview

Three packages form the security stack on top of the DI container:

- `@agentback/security` — vocabulary: `Principal`, `UserProfile`,
  `ClientApplication`, `SecurityBindings`.
- `@agentback/authentication` — `@authenticate` decorator, strategy
  interface, built-in anonymous/api-key/client-credentials strategies.
  JWT lives in the separate `@agentback/authentication-jwt` component.
- `@agentback/authorization` — `@authorize` decorator, voter pipeline,
  preset decorators, client-scope governance.

Rate limiting uses `@agentback/extension-rate-limit` for REST and the
`rateLimit` option in `@agentback/mcp-http` for MCP-over-HTTP.

## Authentication

### Strategy Interface

```ts
interface AuthenticationStrategy {
  name: string; // matches the @authenticate('name') argument
  authenticate(
    request: Request,
    options?: Record<string, unknown>,
  ): Promise<UserProfile | AuthenticationResult | undefined>;
}

// A strategy may return a bare UserProfile (shorthand for {user}) or:
interface AuthenticationResult {
  user?: UserProfile;
  clientApplication?: ClientApplication;
}
```

`normalizeAuthResult(raw)` coerces either form into an `AuthenticationResult`;
it's used by the REST server and by `frameworkAuthGuard` — the Express guard
`@agentback/mcp-http` uses to authenticate `/mcp` with these same
strategies (see [MCP-over-HTTP: Auth and Rate Limiting](#mcp-over-http-auth-and-rate-limiting)).

### `@authenticate` and Strategy Registration

```ts
import {authenticate, AuthenticationBindings} from '@agentback/authentication';

@authenticate('jwt')          // class-level default
class OrderController {
  @get('/orders') list() { ... }

  @get('/health')
  @authenticate.skip()        // bypass auth on this method
  health() { return {ok: true}; }
}

// Register a custom strategy — tag with AUTH_STRATEGY so the interceptor
// discovers it via findByTag:
app
  .bind('strategies.mine')
  .toClass(MyStrategy)
  .tag(AuthenticationBindings.AUTH_STRATEGY);
```

Method-level metadata wins over class-level. `resolveStrategy(context, name)`
and `getAuthenticationMetadata(ctor, method)` are available for advanced use.

### Built-In Strategies

**Anonymous** — `name: 'anonymous'`; never throws; returns `ANONYMOUS_USER`
(`{[securityId]: '$anonymous'}`). Register with `app.service(AnonymousAuthenticationStrategy)`.

**API key** — `name: 'api-key'`; reads `x-api-key` header or `?apiKey`. Bind
an `ApiKeyVerifier` at `API_KEY_VERIFIER`:

```ts
import {
  ApiKeyAuthenticationStrategy,
  API_KEY_VERIFIER,
  AuthenticationBindings,
} from '@agentback/authentication';
import {securityId} from '@agentback/security';

app
  .bind(API_KEY_VERIFIER)
  .to(async (key: string) =>
    key === process.env.API_KEY
      ? {[securityId]: 'svc', name: 'svc'}
      : undefined,
  );
app
  .bind('strategies.apiKey')
  .toClass(ApiKeyAuthenticationStrategy)
  .tag(AuthenticationBindings.AUTH_STRATEGY);
```

**Client credentials** — `name: 'client-credentials'`; reads `client_id`/
`client_secret` headers or Basic auth. Bind a `ClientCredentialsVerifier` at
`CLIENT_CREDENTIALS_VERIFIER`; the verifier returns a `ClientApplication` which
the REST server deposits at `SecurityBindings.CLIENT_APPLICATION`.

**JWT** — provided by `JWTAuthenticationComponent` (`name: 'jwt'`). Also
registers `JWTService` (for `generateToken`/`verifyToken`) and a spec enhancer
that adds `securitySchemes.jwtAuth` to the OpenAPI output:

```ts
import {
  JWTAuthenticationComponent,
  JWTBindings,
  JWTService,
} from '@agentback/authentication-jwt';

app.bind(JWTBindings.SECRET).to(process.env.JWT_SECRET!);
app.bind(JWTBindings.EXPIRES_IN).to('1h');
app.component(JWTAuthenticationComponent);
```

## Authorization

### `@authorize` Decorator

```ts
import {authorize, EVERYONE, AUTHENTICATED} from '@agentback/authorization';

@authenticate('jwt')
@authorize({allowedRoles: [AUTHENTICATED]})   // class-level: any authed user
class OrderController {
  @get('/orders') list() { ... }

  @post('/orders')
  @authorize({allowedRoles: ['admin', 'manager']})
  create() { ... }

  @del('/orders/{id}')
  @authorize({scopes: ['orders:delete']})
  remove() { ... }

  @get('/health')
  @authenticate.skip() @authorize.skip()
  health() { return {ok: true}; }
}
```

`AuthorizationMetadata` fields: `allowedRoles`, `deniedRoles`, `scopes`,
`voters` (inline `Authorizer[]`), `resource`, `skip`.

Pseudo-roles always in the effective set: `EVERYONE` (`'$everyone'`),
`AUTHENTICATED` (`'$authenticated'`), `UNAUTHENTICATED` (`'$unauthenticated'`).

### Voter Pipeline

`runAuthorization(ctx, meta, context)` runs in order:

1. Per-route `voters` from `AuthorizationMetadata`.
2. Global voters bound with `GLOBAL_VOTER_TAG`.
3. `defaultRoleVoter` — enforces `deniedRoles` → `allowedRoles` → `scopes`.

First non-`ABSTAIN` (`AuthorizationDecision`) wins. All abstaining → `DENY`.

```ts
import {type Authorizer, AuthorizationDecision, GLOBAL_VOTER_TAG} from '@agentback/authorization';

// Inline voter:
const ownerOnly: Authorizer = (ctx, _meta) => {
  if (ctx.user?.[securityId] === ctx.resource.split(':')[1])
    return AuthorizationDecision.ALLOW;
  return AuthorizationDecision.ABSTAIN;
};
@authorize({voters: [ownerOnly], allowedRoles: ['admin']}) update() { ... }

// Global voter — applies to every route:
app.bind('voters.audit').to(auditVoter).tag(GLOBAL_VOTER_TAG);
```

### Preset Decorators

| Preset                                  | Equivalent                                                |
| --------------------------------------- | --------------------------------------------------------- |
| `roleAuth(roles, ...scopes)`            | `@authorize({allowedRoles, scopes?})`                     |
| `authRequired(...scopes)`               | require `$authenticated`                                  |
| `publicRoute()`                         | `@authorize({allowedRoles: ['$everyone']})`               |
| `requireScopes(s, ...rest)` / `.skip()` | require / bypass listed scopes                            |
| `tenantOnly(...ids)`                    | voter — reads `AUTHORIZATION_CURRENT_TENANT`, fail-closed |
| `composeAuthDecorators(...decs)`        | apply multiple decorators as one                          |

```ts
import {authenticate} from '@agentback/authentication';
import {
  authRequired,
  composeAuthDecorators,
  requireScopes,
  roleAuth,
} from '@agentback/authorization';

const jwtAdmin = composeAuthDecorators(authenticate('jwt'), roleAuth('admin'));

class OrderController {
  @authRequired() list() {}
  @jwtAdmin create() {}
  @requireScopes('orders:del') remove() {}
}
```

## Client-Application Scope Governance

`ClientApplication` (from `@agentback/security`) carries `allowedScopes`
and `disallowedScopes`. `clientAppScopeVoter` enforces them independently of
the user's own scopes.

Three scope sentinels from `@agentback/authorization`:

- `SCOPE_ALL` (`'ALL'`) — grants all scopes except `SCOPE_INTERNAL`.
- `SCOPE_PUBLIC` (`'PUBLIC'`) — needs no governance.
- `SCOPE_INTERNAL` (`'INTERNAL'`) — must be listed explicitly; `ALL` does not
  grant it.

`areScopesAllowed(clientApp, requestedScopes)` is the pure predicate.
`clientAppScopeVoter` DENYs when the app forbids the route's required scopes
and ABSTAINs otherwise (so `defaultRoleVoter` still checks the user's scopes):

```ts
import {
  clientAppScopeVoter,
  requireScopes,
  GLOBAL_VOTER_TAG,
} from '@agentback/authorization';
import {SecurityBindings} from '@agentback/security';

app.bind('voters.clientScopes').to(clientAppScopeVoter).tag(GLOBAL_VOTER_TAG);

class ServiceController {
  // A client that holds the user grant but whose ClientApplication only has
  // allowedScopes: ['orders:read'] receives 403 — app-level check is stricter.
  @authenticate('client-credentials')
  @requireScopes('orders:write')
  @get('/orders')
  orders(@inject(SecurityBindings.CLIENT_APPLICATION) app: ClientApplication) {
    return {client: app[securityId]};
  }
}
```

`SecurityBindings.CLIENT_APPLICATION` is deposited by the REST server after
the client-credentials strategy resolves the `ClientApplication`.

## How REST Wires It

`RestServer.dispatch` runs two interceptors automatically:

1. **Auth interceptor** — reads `@authenticate` metadata, resolves the strategy
   by name, calls `strategy.authenticate(request)`, and deposits
   `SecurityBindings.USER` and/or `SecurityBindings.CLIENT_APPLICATION` into
   the per-request context. Throws 401 on failure; passes through when
   `skip: true`.
2. **Authorization interceptor** — reads `@authorize` metadata, builds
   `AuthorizationContext` via `buildAuthorizationContext(user, resource)`, calls
   `runAuthorization`. Throws 403 on `DENY`.

Routes with no `@authenticate`/`@authorize` are unrestricted.

## Rate Limiting — REST

```ts
import {installRateLimit} from '@agentback/extension-rate-limit';

// In-memory: 100 req / 60s per client IP.
await installRateLimit(app, {points: 100, durationSecs: 60});

// Redis-backed, scoped to /api, custom key, probe bypass.
await installRateLimit(app, {
  path: '/api',
  points: 1000,
  durationSecs: 60,
  store: redisClient, // ioredis-compatible
  keyGenerator: req => (req.headers['x-api-key'] as string) ?? req.ip ?? 'anon',
  skip: req => req.path === '/health',
});
```

Key `RateLimitOptions` fields: `points` (100), `durationSecs` (60),
`blockSecs` (0), `keyGenerator` (client IP), `skip`, `store`, `headers` (true
— emits `RateLimit-Limit/Remaining/Reset`), `statusCode` (429), `message`.

On limit exceeded: configured status + `Retry-After`. Store failures
**fail open**. `installRateLimit` wraps `mountRateLimit(server, opts)`;
`createRateLimitMiddleware(opts)` gives the raw Express `RequestHandler`.

## MCP-over-HTTP: Auth and Rate Limiting

`@agentback/mcp-http` exposes the same `@tool`/`@resource`/`@prompt`
surface over Streamable HTTP. Auth and rate limiting are options on
`installMcpHttp`.

### Framework-Strategy Auth (`strategyAuth`)

Reuses the same `@agentback/authentication` strategies as REST. On success
it sets `req.auth` (`AuthInfo`) whose `scopes` drive per-session tool filtering
— a session only **sees** tools whose `scope` field is covered by the caller's
granted scopes.

```ts
import {installMcpHttp} from '@agentback/mcp-http';
import {
  ApiKeyAuthenticationStrategy,
  API_KEY_VERIFIER,
  AuthenticationBindings,
} from '@agentback/authentication';
import {securityId} from '@agentback/security';

const KEYS: Record<string, {[typeof securityId]: string; scopes: string[]}> = {
  'admin-key': {[securityId]: 'admin', scopes: ['admin', 'mcp:tools']},
  'user-key': {[securityId]: 'user', scopes: ['mcp:tools']},
};
app.bind(API_KEY_VERIFIER).to((key: string) => KEYS[key]);
app
  .bind('strategies.apiKey')
  .toClass(ApiKeyAuthenticationStrategy)
  .tag(AuthenticationBindings.AUTH_STRATEGY);

await installMcpHttp(app, {
  strategyAuth: {strategy: 'api-key'}, // or ['api-key', 'jwt']
  // strategyAuth: {strategy: 'jwt', required: false} — optional auth
});
```

Scope a tool to a required scope (tools without `scope` are always visible):

```ts
@tool('admin_ping', {description: 'Admin-only.', scope: 'admin'})
async adminPing(): Promise<{ok: boolean}> { return {ok: true}; }
```

`McpStrategyAuthOptions`: `strategy` (name or array), `required` (default
`true`), `scopes` (override scope derivation), `context` (auto from
`installMcpHttp`). For a full OAuth 2.1 resource-server setup, use the `auth`
option with an `OAuthTokenVerifier` instead (or alongside `strategyAuth`).

### Per-Tool Rate Limiting (`rateLimit`)

Throttle `tools/call` per **(caller, tool)** bucket. Other methods (`initialize`,
`tools/list`) are not limited.

```ts
await installMcpHttp(app, {
  strategyAuth: {strategy: 'api-key'},
  rateLimit: {
    points: 30, // calls / window for any tool
    durationSecs: 60,
    perTool: {add: {points: 5, durationSecs: 60}}, // tighter for one tool
    // store: redisClient — share across instances
  },
});
```

`McpToolRateLimitOptions`: `points` (60), `durationSecs` (60), `blockSecs` (0),
`perTool` (per-tool overrides), `keyGenerator` (`req.auth.clientId` or IP),
`store`, `keyPrefix` (`'mcp-tool'`). On exceed: 429 + JSON-RPC error
(`code: -32029`) + `Retry-After`. Store failures fail open. The underlying
middleware is exported as `toolRateLimitMiddleware(options)`.

## Key Rules

- **Strategy discovery is tag-based.** Every strategy must be bound with
  `AuthenticationBindings.AUTH_STRATEGY` (`'authentication.strategy'`); `app.service()`
  works when the class carries the tag via `@injectable`.
- **Method metadata wins.** `authenticate.skip()` / `authorize.skip()` override
  class-level decorators.
- **Voter order: per-route → global → `defaultRoleVoter`.** First non-`ABSTAIN`
  wins; all abstaining → `DENY`.
- **`clientAppScopeVoter` is opt-in.** Bind it as a global voter only when you
  need per-application scope governance on top of user scopes.
- **`SCOPE_INTERNAL` is never granted by `SCOPE_ALL`.** List it explicitly.
- **REST rate limiting is global unless `path` is set.** Without `path`,
  `installRateLimit` applies to every route, including `/mcp`.
- **`rateLimit` uses `req.auth.clientId` as the bucket key** when
  `strategyAuth` (or OAuth `auth`) is also configured — so limits are
  per-authenticated-caller rather than per-IP.
- **Store failures always fail open** in both rate limiters.
