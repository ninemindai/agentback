# @agentback/security

> Common security primitives — `Principal`, `UserProfile`, `Subject`, and
> their DI binding keys.

ESM port of [`@loopback/security`](https://github.com/loopbackio/loopback-next/tree/master/packages/security).
A thin, dependency-free vocabulary layer consumed by `@agentback/authentication`
and `@agentback/authorization`. It defines the "who" (`Subject`, principals)
and the "what" (`Permission`, `Scope`) without any transport or HTTP coupling.

## What it provides

**Identity**

- `securityId` — unique `Symbol` required on every `Principal` to provide a
  canonical string identity.
- `Principal` — base interface: `{ [securityId]: string; [attr: string]: any }`.
- `TypedPrincipal` — wraps a `Principal` with a type string (`'USER'`,
  `'APPLICATION'`, …); `securityId` becomes `'TYPE:id'`.
- `UserProfile` — a `Principal` with optional `email` and `name` fields; the
  type used by authentication strategies.
- `Organization`, `Team`, `Role` — additional `Principal` subtypes.
- `ClientApplication` — a `Principal` for an API-key/OAuth2 client, carrying
  optional `name`, `allowedScopes`, and `disallowedScopes` consumed by
  `@agentback/authorization`'s scope governance.

**Subject**

- `Subject` — holds three `Set`s: `principals`, `credentials`, `authorities`.
- `DefaultSubject` — mutable implementation with `addUser()`, `addApplication()`,
  `addAuthority()`, `addCredential()`, and a `user` getter.

**Authorization**

- `Credential` — marker interface for authentication secrets.
- `Permission` — encodes an `action` + `resourceType` (+ optional property /
  instance id); its `securityId` encodes `resourceType.prop:action[:id]`.
- `Scope` — a `Permission` with a `name` field (OAuth 2.0 scopes).

**DI bindings**

- `SecurityBindings.SUBJECT` → `'security.subject'` — the resolved `Subject`
  for the current request.
- `SecurityBindings.USER` → `'security.user'` — the resolved `UserProfile` for
  the current request.
- `SecurityBindings.CLIENT_APPLICATION` → `'security.clientApplication'` — the
  current request's `ClientApplication` (deposited by an auth strategy; read by
  authorization scope governance).

## Usage

```ts
import {
  DefaultSubject,
  SecurityBindings,
  UserProfile,
  securityId,
} from '@agentback/security';
import {inject} from '@agentback/core';

// Build a subject in an auth strategy
const subject = new DefaultSubject();
subject.addUser({[securityId]: 'user-42', email: 'alice@example.com'});

// In a controller, inject the current user
class OrderController {
  constructor(
    @inject(SecurityBindings.USER) private currentUser: UserProfile,
  ) {}

  async listOrders() {
    // this.currentUser.email is typed and DI-resolved per-request
  }
}
```

## Layering

Depends on: `@agentback/core` (for `BindingKey`).  
This package is a pure vocabulary layer — no middleware, no HTTP, no crypto.
`@agentback/authentication` and `@agentback/authorization` depend on
it; application code that only needs to read the current user can import
`SecurityBindings` and `UserProfile` directly from here.
