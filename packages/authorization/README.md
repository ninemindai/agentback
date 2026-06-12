# @agentback/authorization

> `@authorize` decorator + composable voter pipeline — minimal ESM port of
> `@loopback/authorization`, no `@loopback/repository` dependencies.

Provides the decorator that attaches authorization requirements to controller
classes and methods, a built-in role/scope voter, a global voter extension
point, and the resolver that runs them in order. The pipeline is policy-agnostic:
extend it by writing `Authorizer` functions and binding them (or passing them
inline) without touching any framework internals.

```bash
pnpm add @agentback/authorization
```

## What it provides

| Export                                           | Kind               | Purpose                                                                                                                                             |
| ------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `authorize(meta)`                                | decorator          | Attach `AuthorizationMetadata` to a class or method; `authorize.skip()` bypasses class-level auth; `authorize.allowedRoles(...roles)` is a shortcut |
| `AuthorizationMetadata`                          | interface          | `allowedRoles`, `deniedRoles`, `scopes`, `voters`, `resource`, `skip`                                                                               |
| `AuthorizationContext`                           | interface          | Per-request context: `principals`, `roles`, `scopes`, `resource`, `user`                                                                            |
| `AuthorizationDecision`                          | enum               | `ALLOW`, `DENY`, `ABSTAIN`                                                                                                                          |
| `Authorizer`                                     | type               | `(ctx, meta) => AuthorizationDecision \| Promise<AuthorizationDecision>`                                                                            |
| `EVERYONE` / `AUTHENTICATED` / `UNAUTHENTICATED` | string constants   | Built-in pseudo-roles                                                                                                                               |
| `defaultRoleVoter`                               | `Authorizer`       | Enforces `deniedRoles` → `allowedRoles` → `scopes`; returns `ABSTAIN` when no rule applies                                                          |
| `runAuthorization(ctx, meta, context)`           | function           | Runs per-route voters, then global voters (by `GLOBAL_VOTER_TAG`), then `defaultRoleVoter`; first non-`ABSTAIN` decision wins; defaults to `DENY`   |
| `buildAuthorizationContext(user, resource)`      | function           | Builds `AuthorizationContext` from a `UserProfile` (or `undefined` for anonymous)                                                                   |
| `getAuthorizationMetadata(ctor, method)`         | function           | Read effective metadata — method wins over class                                                                                                    |
| `AuthorizationKeys.METADATA`                     | `MetadataAccessor` | Reflection key (method-level)                                                                                                                       |
| `AuthorizationKeys.CLASS_METADATA`               | `MetadataAccessor` | Reflection key (class-level)                                                                                                                        |
| `GLOBAL_VOTER_TAG`                               | string             | Tag for binding global `Authorizer` functions into the DI container                                                                                 |
| `AUTHORIZATION_CURRENT_TENANT`                   | `BindingKey`       | Request-scoped tenant (id string or `{id}`) read by `tenantOnly`                                                                                    |

### Preset decorators

Terse, composable shortcuts over `@authorize` for common cases:

| Export                                                    | Equivalent                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `roleAuth(roles, ...scopes)`                              | `@authorize({allowedRoles, scopes})`                                                          |
| `authRequired(...scopes)`                                 | require an authenticated user (`$authenticated`)                                              |
| `publicRoute()`                                           | allow everyone (`$everyone`)                                                                  |
| `requireScopes(scope, ...extra)` / `requireScopes.skip()` | require / bypass scopes                                                                       |
| `tenantOnly(...tenantIds)`                                | voter that allows only the listed tenants (reads `AUTHORIZATION_CURRENT_TENANT`; fail-closed) |
| `composeAuthDecorators(...decorators)`                    | apply several class/method decorators as one — e.g. bundle `authenticate()` + a preset        |

## Usage

```ts
import {authorize, EVERYONE, AuthorizationDecision} from '@agentback/authorization';
import {authenticate} from '@agentback/authentication';
import {get, post, del} from '@agentback/openapi';

// Class-level default: any authenticated user.
@authenticate('jwt')
@authorize({allowedRoles: ['$authenticated']})
class OrderController {

  @get('/orders')
  list() { ... }

  // Tighten on a single method.
  @post('/orders')
  @authorize({allowedRoles: ['admin', 'manager']})
  create() { ... }

  // Require an OAuth scope.
  @del('/orders/{id}')
  @authorize({scopes: ['orders:delete']})
  remove() { ... }

  // Public endpoint — bypass auth + authorization.
  @get('/orders/health')
  @authenticate.skip()
  @authorize.skip()
  health() { return {ok: true}; }
}
```

Inline custom voter:

```ts
import {type Authorizer, AuthorizationDecision} from '@agentback/authorization';

const ownerOnly: Authorizer = (ctx, _meta) => {
  if (ctx.user?.id === ctx.resource.split('.')[1]) return AuthorizationDecision.ALLOW;
  return AuthorizationDecision.ABSTAIN;
};

@authorize({voters: [ownerOnly], allowedRoles: ['admin']})
@patch('/orders/{id}')
update() { ... }
```

Global voter (DI-bound, applies to every route):

```ts
import {GLOBAL_VOTER_TAG} from '@agentback/authorization';

app.bind('voters.audit').to(auditVoter).tag(GLOBAL_VOTER_TAG);
```

Preset decorators (define your own role names on top of the generics):

```ts
import {authenticate} from '@agentback/authentication';
import {
  authRequired,
  composeAuthDecorators,
  requireScopes,
  roleAuth,
  tenantOnly,
} from '@agentback/authorization';

// App-defined shortcuts:
const adminOnly = roleAuth('admin');
const jwtAdmin = composeAuthDecorators(authenticate('jwt'), roleAuth('admin'));

class OrderController {
  @authRequired() list() {} // any authenticated user
  @jwtAdmin create() {} // authenticate + require admin
  @requireScopes('orders:delete') remove() {}
  @tenantOnly('acme', 'globex') reports() {} // tenant-scoped
}
```

`tenantOnly` reads the current tenant from the request context — bind it (e.g.
from an auth strategy or a multi-tenancy interceptor):

```ts
import {AUTHORIZATION_CURRENT_TENANT} from '@agentback/authorization';
requestCtx.bind(AUTHORIZATION_CURRENT_TENANT).to({id: 'acme'});
```

## Client-application scope governance

Beyond per-user roles/scopes, you can govern what a **client application** (an
API-key or OAuth2 client) is allowed to do, independent of the user. A
`ClientApplication` (from `@agentback/security`) carries
`allowedScopes`/`disallowedScopes`; `clientAppScopeVoter` enforces them.

| Export                                          | Purpose                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `areScopesAllowed(clientApp, scopes)`           | Pure predicate: may this app use these scopes?                                                                                 |
| `clientAppScopeVoter`                           | `Authorizer` — DENY if the bound client app forbids the route's `scopes`, else ABSTAIN                                         |
| `SCOPE_ALL` / `SCOPE_PUBLIC` / `SCOPE_INTERNAL` | Scope sentinels (`ALL` grants everything **except** `INTERNAL`, which must be listed explicitly; `PUBLIC` needs no governance) |

```ts
import {
  clientAppScopeVoter,
  GLOBAL_VOTER_TAG,
} from '@agentback/authorization';
import {SecurityBindings} from '@agentback/security';

// 1. Enforce client-app scopes on every route:
app.bind('voters.clientScopes').to(clientAppScopeVoter).tag(GLOBAL_VOTER_TAG);

// 2. An authentication strategy (or interceptor) deposits the resolved app:
requestCtx.bind(SecurityBindings.CLIENT_APPLICATION).to({
  [securityId]: 'app-123',
  name: 'Partner API',
  allowedScopes: ['orders:read', 'orders:write'],
  disallowedScopes: ['admin:*'],
});
```

The voter ABSTAINs (deferring to the user's own scope check in
`defaultRoleVoter`) when no client app is bound or the scopes are permitted, and
DENYs when the app forbids them — so a route requires **both** that the user has
the scope and that the client app is allowed to use it.

## Auth flow

```mermaid
sequenceDiagram
    participant R as REST request
    participant A as auth interceptor
    participant Z as authorization interceptor
    participant V1 as inline voters
    participant V2 as global voters
    participant VD as defaultRoleVoter

    R->>A: authenticate(request) → UserProfile
    A->>Z: UserProfile in context
    Z->>Z: buildAuthorizationContext(user, resource)
    Z->>V1: run per-route voters (AuthorizationMetadata.voters)
    V1-->>Z: ALLOW / DENY / ABSTAIN
    Z->>V2: run global voters (GLOBAL_VOTER_TAG)
    V2-->>Z: ALLOW / DENY / ABSTAIN
    Z->>VD: defaultRoleVoter (roles + scopes)
    VD-->>Z: ALLOW / DENY / ABSTAIN
    Z-->>R: first non-ABSTAIN wins; all-ABSTAIN → DENY
```

## Layering

Depends on: `@agentback/context`, `@agentback/core`,
`@agentback/metadata`, `@agentback/security`.

Sits alongside `@agentback/authentication` (consumes the `UserProfile` it
produces) and is enforced by the REST auth interceptor in
`@agentback/rest`. No dependency on `authentication` itself — the two
packages are composed at the interceptor layer.
