# @agentback/authentication-oauth2

> OAuth2 opaque bearer-token authentication — validates access tokens against
> any RFC 7662 introspection endpoint. Bring your own authorization server.

Wires an OAuth2 resource-server auth stack into an AgentBack application via
a single component. An opaque access token carries no verifiable signature, so
the only way to know whether one is live is to ask the issuing authorization
server: this package owns that introspection call (RFC 7662), the resource
server's own client authentication to the endpoint, and the mapping of the
response onto the framework's principal model. Authorization-server agnostic —
point it at Keycloak, Okta, WorkOS, Ory, Cognito, or anything that speaks
RFC 7662.

```bash
pnpm add @agentback/authentication-oauth2
```

## What it provides

| Export                          | Kind                                     | Purpose                                                                                                                 |
| ------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OAuth2AuthenticationComponent` | `Component` class                        | Registers the service, strategy, and OpenAPI enhancer in one call                                                       |
| `OAuth2IntrospectionService`    | injectable class                         | `introspect(token)` — POSTs to the AS, returns claims on `active`, throws `401` on inactive / `503` on endpoint failure |
| `OAuth2AuthenticationStrategy`  | injectable class                         | Implements `AuthenticationStrategy` with `name = 'oauth2'`; reads `Authorization: Bearer <token>`                       |
| `OAuth2SecuritySpecEnhancer`    | injectable class                         | Adds `securitySchemes.oauth2Auth` (http/bearer) to the assembled OpenAPI 3.1 spec                                       |
| `OAuth2Bindings.CONFIG`         | `BindingKey<OAuth2IntrospectionConfig>`  | Introspection endpoint + the resource server's client credentials — bind before the component                           |
| `OAuth2Bindings.SERVICE`        | `BindingKey<OAuth2IntrospectionService>` | Resolved service instance                                                                                               |
| `OAuth2Bindings.FETCH`          | `BindingKey<FetchLike>`                  | Optional `fetch` override (defaults to global `fetch`) — swap for a stub in tests or an in-process AS                   |

For issuers that mint **JWT** access tokens (RFC 9068), a sibling stack verifies
them locally against the AS's JWKS — no per-request network call:

| Export                             | Kind                          | Purpose                                                                                              |
| ---------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `OAuth2JwtAuthenticationComponent` | `Component` class             | Registers the JWT service, strategy, and OpenAPI enhancer                                            |
| `JwtAccessTokenService`            | injectable class              | `verify(token)` — checks the JWT signature (JWKS) and `iss`/`aud`/`exp`; throws `401` on any failure |
| `OAuth2JwtAuthenticationStrategy`  | injectable class              | `AuthenticationStrategy` with `name = 'oauth2-jwt'`                                                  |
| `OAuth2JwtBindings.CONFIG`         | `BindingKey<OAuth2JwtConfig>` | `issuer` / `audience` / `jwksUri`                                                                    |
| `OAuth2JwtBindings.KEY_RESOLVER`   | `BindingKey<JwtKeyInput>`     | Optional explicit signing key/resolver (defaults to a remote JWKS from `jwksUri`)                    |
| `claimsToAuthResult`               | function                      | Shared claims → `{user}`/`{clientApplication}` mapping used by both strategies                       |

## Configuration

```ts
interface OAuth2IntrospectionConfig {
  introspectionUrl: string; // the AS's RFC 7662 endpoint
  clientId?: string; // THIS resource server's credentials
  clientSecret?: string; //   (used to call the endpoint)
  clientAuthMethod?: 'basic' | 'post' | 'none'; // default 'basic'
  tokenTypeHint?: string; // default 'access_token'
  headers?: Record<string, string>; // extra static headers (e.g. a gateway key)
  cache?: boolean | {ttlSeconds?: number; maxEntries?: number}; // see Caching
}
```

The `clientId`/`clientSecret` here are **the resource server's** credentials for
authenticating the introspection call — they are _not_ the end user's. That is a
second credential, separate from whatever bearer token the caller presents.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {authenticate} from '@agentback/authentication';
import {requireScopes} from '@agentback/authorization';
import {inject} from '@agentback/context';
import {SecurityBindings, type UserProfile} from '@agentback/security';
import {get, post} from '@agentback/openapi';
import {
  OAuth2AuthenticationComponent,
  OAuth2Bindings,
} from '@agentback/authentication-oauth2';

const app = new RestApplication({});

// 1. Bind config before the component.
app.bind(OAuth2Bindings.CONFIG).to({
  introspectionUrl: process.env.OAUTH2_INTROSPECTION_URL!,
  clientId: process.env.OAUTH2_CLIENT_ID!,
  clientSecret: process.env.OAUTH2_CLIENT_SECRET!,
});
app.component(OAuth2AuthenticationComponent);

// 2. Protect routes with @authenticate('oauth2').
class WidgetController {
  @authenticate('oauth2')
  @get('/widgets')
  list(@inject(SecurityBindings.USER) user: UserProfile) {
    return {principal: user[securityId]};
  }

  // Scope from the token's `scope` claim, governed by @agentback/authorization.
  @authenticate('oauth2')
  @requireScopes('widgets:write')
  @post('/widgets')
  create() {
    return {ok: true};
  }
}

app.restController(WidgetController);
await app.start();
```

## User tokens vs client (machine) tokens

An opaque token can represent a _resource owner_ or a _machine client_, and the
strategy maps each onto the right framework principal automatically:

- token with a `sub` → `{user}` (a `UserProfile`), with the granted scopes
  normalized onto `user.scopes`. Inject via `SecurityBindings.USER`.
- token with only a `client_id` (client-credentials grant) →
  `{clientApplication}` (a `ClientApplication`), with the scopes on
  `allowedScopes`. Inject via `SecurityBindings.CLIENT_APPLICATION`.

Because both flow through the framework's `AuthenticationResult`, the same
`@requireScopes(...)` / `clientAppScopeVoter` governance applies to human and
service-to-service callers without branching on token kind.

## Scope normalization

RFC 7662 returns `scope` as a single space-delimited string. The strategy splits
it into `string[]` once, at the boundary, so the rest of the stack
(`@agentback/authorization`, `@agentback/mcp-http` tool filtering)
sees a clean array. The RFC framing claims (`active`, `exp`, `iat`, `nbf`,
`token_type`) are stripped from the principal; all other claims pass through.

## Error semantics

- A well-formed token the AS reports as inactive/unknown → **401** (the caller
  is unauthenticated).
- The introspection endpoint unreachable or returning non-2xx → **503** (a
  dependency failed). This is deliberately _not_ folded into a 401 — an AS
  outage must not masquerade as "bad credentials".

## JWT access tokens (local verification)

When your AS issues **JWT** access tokens, you can skip introspection entirely —
the token carries its own signature, so it is verified locally against the AS's
JWKS. Use the sibling component:

```ts
import {
  OAuth2JwtAuthenticationComponent,
  OAuth2JwtBindings,
} from '@agentback/authentication-oauth2';

app.bind(OAuth2JwtBindings.CONFIG).to({
  issuer: process.env.OAUTH2_ISSUER!, // expected `iss`
  audience: process.env.OAUTH2_AUDIENCE!, // your API identifier (`aud`)
  jwksUri: process.env.OAUTH2_JWKS_URI!, // AS signing keys (cached remote JWKS)
});
app.component(OAuth2JwtAuthenticationComponent);

// then: @authenticate('oauth2-jwt')
```

Both strategies share the same principal mapping, so JWT and opaque tokens
surface identical `{user}`/`{clientApplication}` principals. The JWT strategy
also understands the array `scp` scope form (e.g. Azure AD) in addition to the
space-delimited `scope` string. To accept **either** token form on a route, list
both names — they are tried in order: `@authenticate('oauth2-jwt', 'oauth2')`.

## Caching (opaque introspection)

Opaque-token validation is a network round-trip to the AS per request — the cost
of having no local signature. Enable the built-in cache to amortize it:

```ts
app.bind(OAuth2Bindings.CONFIG).to({
  introspectionUrl: '…',
  clientId: '…',
  clientSecret: '…',
  cache: true, // or {ttlSeconds: 30, maxEntries: 5000}
});
```

Entries are keyed by a **SHA-256 digest of the token** (the raw token is never
stored), and their lifetime is the lesser of `ttlSeconds` (default 60) and the
token's own `exp`. Inactive/rejected tokens are never cached, so revocation
still takes effect within the TTL. JWT access tokens need no such cache — they
are verified locally.

## Composing with MCP-over-HTTP

Either strategy serves `@agentback/mcp-http` — list it in
`installMcpHttp({strategyAuth: {strategy: 'oauth2'}})` (or `'oauth2-jwt'`) and
the identical tokens gate MCP tool visibility by scope, with no extra code.

## Layering

Depends on: `@agentback/authentication`, `@agentback/context`,
`@agentback/core`, `@agentback/openapi`, `@agentback/security`,
`http-errors`, and `jose` (JWKS verification for the JWT strategy).

Sits above `@agentback/authentication` (implements its strategy interface)
and is consumed directly by application code. The `OAuth2SecuritySpecEnhancer`
integrates with `@agentback/openapi`'s enhancer extension point so Swagger
UI reflects the correct security scheme without manual spec edits. For a
runnable end-to-end demo (including an in-process stand-in authorization server),
see `examples/hello-oauth2`.
