# Proposal P0-1: One Policy Layer for REST Routes and MCP Tools

**Status:** Implemented (2026-06-10).
**Packages touched:** `mcp`, `mcp-http`, `authorization`, `security` (read-only), `rest` (no behavior change).
**Related:** [agent-ergonomics.md](../agent-ergonomics.md), [p1-3-mcp-suite-completion.md](p1-3-mcp-suite-completion.md).

## Motivation

The framework's pitch is "same class, two surfaces" — but today that is only true
for schemas, not for security:

- **REST** runs a full policy pipeline per request:
  `RestServer.dispatch` → `authenticate()` (resolves the `@authenticate`
  strategy, binds `SecurityBindings.USER` / `CLIENT_APPLICATION` into the
  request context) → `authorize()` (reads `@authorize` metadata, runs the
  voter chain via `runAuthorization`, throws 403 on deny).
  See `packages/rest/src/rest.server.ts:177-233`.
- **MCP** has a parallel, weaker mechanism: `@tool` takes a single
  `scope?: string`, and `MCPServer.registerAllOn(target, scopes)` skips tools
  whose scope is not in the session's scopes (`packages/mcp/src/mcp.server.ts:323`).
  `dispatchTool` performs **no** authorization; the `@authorize` decorator is
  silently ignored on tool methods.

Per-tool authorization is the emerging core abstraction of the MCP era (the
2025-11 MCP auth revision, every auth vendor's positioning). Making one
declaration govern both surfaces is the feature that makes the hybrid-class
story true for security.

## Design

### One declaration

`@authorize` becomes the single policy declaration for both surfaces:

```ts
@authorize({scopes: ['orders:write']})
@post('/orders', {body: NewOrder, response: Order})
@tool('create_order', {input: NewOrder, output: Order})
async createOrder(input: {body: z.infer<typeof NewOrder>}) { … }
```

- **REST** (unchanged): deny → 403.
- **MCP visibility:** a tool whose method carries `@authorize({scopes})` is
  omitted from `tools/list` for sessions lacking any required scope.
- **MCP call time:** `dispatchTool` runs the same voter chain
  (`runAuthorization`) against the caller's principal; deny → tool error
  result (`isError: true`, message `Forbidden: not authorized for <resource>`).
  Call-time enforcement matters because visibility filtering happens at
  session build time and a defense-in-depth check at dispatch is cheap.

`@tool`'s existing `scope?: string` option stays as a deprecated alias —
internally rewritten to `scopes: [scope]` semantics; removal before 1.0.

### Principal mapping for MCP

MCP transports authenticate at the HTTP layer (OAuth verifier or
`frameworkAuthGuard`), producing the SDK `AuthInfo` that is already bound at
`MCPBindings.REQUEST_AUTH` per request (`mcp.server.ts:367-371`). The gap is
that the authorization voter chain consumes a `UserProfile`, not `AuthInfo`.

Add `authInfoToPrincipals(authInfo)` in `@agentback/mcp`:

1. If `authInfo.extra.user` / `authInfo.extra.clientApplication` exist (the
   shape `frameworkAuthGuard` already produces,
   `packages/mcp-http/src/framework-auth.ts:104-109`), use them directly.
2. Otherwise synthesize a `UserProfile` from OAuth claims:
   `securityId = authInfo.clientId`, `scopes = authInfo.scopes`.

`dispatchTool` then binds `SecurityBindings.USER` (and `CLIENT_APPLICATION`)
into the per-request context — so `@inject(SecurityBindings.USER)` works
identically in REST handlers and tool handlers — and calls
`runAuthorization(buildAuthorizationContext(user, resource), meta, reqCtx)`.

### Scope source for visibility filtering

`registerAllOn(target, scopes)` changes its filter to:

```
required = meta from @authorize on the method (scopes field)
        ?? legacy ToolMetadata.scope (single)
visible  = required is empty
        || every(required, s => sessionScopes.includes(s))
```

`@authorize` metadata is read via `getAuthorizationMetadata(ctor, methodName)`
— the same resolver REST uses, so method-level overrides class-level, and
`@authorize.skip` yields unconditional visibility.

To avoid a hard dependency cycle, `mcp` gains dependencies on
`@agentback/authorization` **and `@agentback/security`** (it binds
`SecurityBindings.USER` and synthesizes `UserProfile`). Both edges are
acyclic (authorization depends on security; nothing depends back on mcp).
The alternative (duplicating metadata keys) violates the one-source-of-truth
thesis.

### Per-request context guarantee (prerequisite refactor)

Today the per-request child `Context` is created **only** in the HTTP handler
closure and only when `extra.authInfo || extra.requestInfo` is present
(`mcp.server.ts:365-374`); `dispatchTool` defaults to the shared app context,
and the public `callTool` path passes no context at all. Binding principals
into the shared context would be a cross-request leak — a security bug.
Step 0 of this proposal therefore refactors `dispatchTool` to **always**
create a per-request child context (`new Context(this.context,
'mcp.request')`), regardless of transport and entry path (HTTP, stdio,
`callTool`, inspector). All request-scoped bindings (`REQUEST_AUTH`,
`REQUEST_INFO`, principals, and P1-3's `REQUEST_EXTRA`/`PROGRESS`) live there.

### Visibility vs enforcement semantics

`@authorize` metadata can carry `scopes`, `allowedRoles`/`deniedRoles`, and
custom `voters`. Visibility filtering (a list-time concern) uses **only**
`scopes` — roles and voters need a principal-specific evaluation that doesn't
fit list-time. A tool gated only by roles/voters therefore stays **visible**
and is denied at call time; this asymmetry is deliberate and documented.

**Behavior change to call out:** `getAuthorizationMetadata` falls back to
class-level `@authorize`. A hybrid controller with class-level
`@authorize(...)` (written with REST in mind) will now also gate its MCP
tools. This is the intended "one declaration" semantic, but it is a
migration-visible change — release notes + a startup `log.info` listing
tools newly gated by class-level metadata.

### stdio transport

stdio has no transport authentication. Defaults:

- No `@authorize` on a tool → callable (today's behavior).
- `@authorize` present and no principal → voter chain runs with empty
  principal; `defaultRoleVoter` denies scope-bearing rules. This is the safe
  default: a tool that demands scopes is not silently open over stdio.
- Escape hatch: `MCPServerConfig.localPrincipal?: UserProfile` to declare the
  ambient identity of a stdio deployment (e.g. roles `['$local']`).

### What does NOT change

- REST dispatch pipeline, voter chain semantics, `AuthorizationDecision`,
  pseudo-roles, the `Authorizer` extension tag (`authorization.voter`) — all
  reused as-is.
- `mcp-http`'s session-scope derivation (from `req.auth.scopes`) is unchanged;
  only the filter inside `registerAllOn` consults richer metadata.

## Implementation plan

0. `mcp`: per-request context guarantee — `dispatchTool` always creates a
   child context; `callTool`/inspector paths included (regression tests for
   no-leak: two sequential calls with different principals never see each
   other's bindings).
1. `mcp`: add `authorization` + `security` deps; `authInfoToPrincipals`; bind principals in
   the per-request context in `dispatchTool`; run voter chain after input
   parse, before inject weave; map deny to tool error result.
2. `mcp`: extend visibility filter in `registerAllOn`; deprecate
   `ToolOptions.scope` (keep working).
3. `mcp`: `localPrincipal` config for stdio.
4. Tests: unit (visibility matrix, call-time deny, principal mapping,
   stdio defaults), acceptance (hybrid controller with `@authorize` on both
   surfaces; one declaration → 403 on REST, hidden+denied on MCP).
5. Docs: composition guide section "one policy, two surfaces".

## Testing

- Visibility: tool with `scopes:['a','b']` visible only when session has both.
- Call-time: forged `tools/call` against a hidden tool → `isError` Forbidden.
- Parity: same class mounted on REST and MCP yields consistent allow/deny for
  the same principal.
- Regression: tools without `@authorize` behave exactly as today on stdio and HTTP.

## Out of scope

- Per-tool rate limiting (exists in `mcp-http`), CIMD/XAA client identity
  (tracked in P1-3), resource/prompt-level authorization (follow-up once
  P1-3 lands resources/prompts aggregation).
