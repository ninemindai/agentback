# Session-Scoped MCP Servers — Design

Status: implemented on `worktree-user-scoped-mcp-spike` (design → review → build)
Owner: MCP
Date: 2026-06-15

## Problem

`MCPServer` is an application-level **singleton** (`servers.MCPServer`, contributed
by `MCPComponent`). Every MCP client that connects over Streamable HTTP sees the
**same** set of `@tool`/`@resource`/`@prompt` members. The only per-caller
variation today is **filtering**: `buildServer({scopes})` plus `@authorize`
hide members whose required scope the caller doesn't hold. The global member set
is fixed.

That is not enough for:

- **Multi-tenant / entitlement** surfaces — tenant A's tools should not merely be
  hidden from tenant B; they should not _exist_ for B (no name leak, no schema
  leak in `tools/list`).
- **Per-user plugins** — a user who installed an integration gets its tools;
  nobody else's server even knows about them.
- **Per-principal dynamic tools** — tools synthesized from the authenticated
  user's account (their projects, their connections).

We want **per-session tool _discovery_**, not just filtering.

## Background: two distinct "per-user" mechanisms (they compose)

| Mechanism                              | Question it answers                              | Status      |
| -------------------------------------- | ------------------------------------------------ | ----------- |
| **Filtering** — scopes + `@authorize`  | "Can _this_ caller call it?"                     | exists      |
| **Discovery** — per-session DI context | "Does this tool _exist_ for this caller at all?" | this design |

They stack: a session-scoped server still runs `buildServer({scopes})`, so a
session-local tool can itself be scope-gated.

## The mechanism (validated by the spike)

Three facts about the existing code combine into the feature:

1. **`MCPServer` injects its own resolution context.** Changed from
   `@inject(CoreBindings.APPLICATION_INSTANCE)` to `@inject.context()`. For the
   app singleton this still resolves to the application context (a singleton
   resolves against its **owner** context — see
   `Context.getResolutionContext` → `getOwnerContext`), so existing behavior is
   unchanged. For an instance bound in a child context, `this.context` becomes
   that child.

2. **Tool discovery is a chain walk.** `this.context.find(extensionFilter(MCP_SERVERS))`
   walks the context up to the root. A session-scoped server at a child context
   therefore discovers the shared app-level tools **plus** any tool binding
   added to its child context — and nothing from sibling sessions (siblings are
   never on each other's chain).

3. **Per-request children already chain off `this.context`.**
   `requestContextFor` does `new Context(this.context, 'mcp.request')`, so a
   session-scoped server's request children correctly inherit its session
   context, keeping principal/auth wiring intact.

Per session, the HTTP transport then:

```
sessionCtx = new Context(appContext, 'mcp.session')
bindSession(sessionCtx, req)                       // populate: principal + user tools
sessionCtx.bind('servers.MCPServer')
          .toClass(MCPServer).inScope(SINGLETON)   // owned by sessionCtx → one per session
sessionMcp = await sessionCtx.get('servers.MCPServer')
sessionMcp.buildServer({scopes}).connect(transport)
```

`SINGLETON` on a binding **owned by** `sessionCtx` means "resolve against the
owner = `sessionCtx`, cache there, one instance per session" — without the
deprecated `CONTEXT` scope.

## Goals

- Per-session tool/resource/prompt **discovery** over Streamable HTTP.
- **Backward compatible**: zero behavior change for apps that don't opt in.
- **Lifecycle-safe**: per-session contexts are created and disposed deterministically.
- **Composes** with existing scope filtering and both auth modes (OAuth
  resource-server + framework strategies).
- Small, idiomatic public surface.

## Non-goals

- **stdio** scoping — one stdio connection is one process/one user; not applicable.
- **Per-user `llms.txt`** — the advertised AX surface reflects the app singleton
  (the public, unauthenticated catalog). Out of scope.
- Changing the **singleton default** — opt-in only.
- Global enumerability of per-user surfaces (`MCPServer.listTools()` introspection
  stays app-level by design).

## The invariant that shapes every decision

> `@inject.context()` MUST remain a **no-op for the app singleton** (owner =
> application context).

This is what makes the same one-line change simultaneously _safe_ for every
existing app and _enabling_ for scoped ones. It is verified empirically: the full
`@agentback/mcp` suite (93 tests) and the whole workspace (2103 tests) pass
unchanged. Any future refactor of `MCPServer`'s context handling must preserve it.

## API design

### Decisions (final, post-review)

- **Name: `perSession`.** The binder fires once per **session**, not per user (a
  user with two clients, or a reconnect that mints a new session id, runs it
  again). Naming it `perUser` would invite treating it as a per-user memoization
  point — a real footgun. The per-user/per-tenant _intent_ lives in the JSDoc;
  the identifier matches the unit. (Review finding R3-A.)
- **Shape: a single binder callback**, not an options object:

  ```ts
  export type SessionBinder = (
    sessionCtx: Context,
    req: Request,
  ) => void | Promise<void>;

  interface McpHttpOptions {
    // ...
    perSession?: SessionBinder;
    /** DI root for session contexts; installMcpHttp fills it automatically. */
    appContext?: Context;
  }
  ```

  `appContext` is a sibling internal option (mirrors `strategyAuth.context`),
  **validated eagerly** at `mountMcpHttp` call time (not on first connect).

- **The binder receives the Express `req`**, not a pre-extracted principal —
  `req.auth` is the canonical principal and a second typed-principal arg would
  fork the auth model (R3-B). The blessed access is `req.auth as AuthInfo`.

- **`addTool(ctx, ToolClass)` helper** (exported from `@agentback/mcp`) is the
  session-scoped counterpart to `app.service(...)`. It routes through
  `createServiceBinding`, so session-local tools carry the same `service` +
  `@mcpServer` extension tags as app-level ones and look identical to the DI/
  schema explorers (R3-C). Callers no longer touch `createBindingFromClass`.

### Example (production-shaped)

```ts
import {addTool} from '@agentback/mcp';

await installMcpHttp(app, {
  auth: {verifier /* … */}, // or strategyAuth
  perSession(ctx, req) {
    const principal = req.auth as AuthInfo | undefined; // validated by the guard
    if (!principal) return; // anonymous → shared set only
    for (const ToolClass of entitlements.toolsFor(principal.clientId)) {
      addTool(ctx, ToolClass); // discovered only for this session
    }
  },
});
```

## Semantics

- **Discovery** — chain walk: app-level tools shared; session-local tools private
  to the session; siblings invisible to each other.
- **Dispatch** — `resolveMember(ctor, reqCtx)` walks from the per-request child
  (which chains off `sessionCtx`), finds the session-local binding, and resolves
  the instance **through its own binding**, so constructor `@inject` resolves
  against `sessionCtx`.
- **Config** — `@config()` resolves by binding key up the chain, so the
  app-level `servers.MCPServer` configuration (name/version/transports) still
  applies to each per-session server. (The per-session binding _shadows_ the
  server binding but not its config binding.)
- **Filtering still applies** — `buildServer({scopes})` runs on the per-session
  instance, so session-local tools can be scope-gated too.

## Lifecycle

The review (R1-A) found the spike closed the context only on `transport.onclose`,
which leaves four leak paths. The implementation closes on **all** of them:

- One `sessionCtx` per session id, created at `initialize`.
- **`transport.onclose`** — DELETE and client-initiated close. Closing releases
  the context's subscriptions/tag-indexer (`Context.close()` exists precisely for
  this `RequestContext`-style disposal).
- **Setup failure** — the binder, schema lowering, or `connect` throwing is caught
  and `sessionCtx.close()`d before rethrowing (an unconnected transport never
  fires `onclose`).
- **App stop** — `mountMcpHttp` returns a `closeAll()` handle that closes every
  outstanding transport; `installMcpHttp` wires it to `app.onStop`. This also
  fixes a _pre-existing_ transport-map leak at shutdown (the per-session binding
  is not an app-level `LifeCycleObserver`, so app lifecycle can't see it).
- **Resumable (`eventStore`) reconnect** reuses the _existing_ transport from the
  `transports` map — no rebuild, no new context, no leak.
- **Known gap (documented):** an idle session that never DELETEs and never
  disconnects is bounded only at shutdown. A TTL/idle reaper is a follow-up (it's
  a pre-existing transport-management gap, not specific to this feature).

## Security

The security review (R2) confirmed isolation holds by construction but flagged
three trust-boundary issues; all are addressed:

- **Isolation by construction (verified)** — each session's tools live in its own
  context; sibling sessions are never on each other's resolution chain (`find`
  walks child→parent only), so there is no cross-session/tenant tool bleed in
  discovery _or_ dispatch. The app-singleton public surfaces (`llms.txt`,
  mcp-inspector, context/schema explorers) resolve against the app context and
  never descend into session contexts, so session-local tools never leak there.
- **Key off validated identity, not headers (R2-B).** The binder reads `req.auth`
  (set by the guards, which run first). The shipped example and the integration
  test use `req.auth.clientId` via a real OAuth verifier — there is **no**
  `x-mcp-user`-header example anywhere. `perSession` without `auth`/`strategyAuth`
  emits a `log.warn` (no validated principal; scope filtering disabled).
- **Session→principal pinning (R2-F).** When auth is configured, each session is
  pinned to the `clientId` that created it; a later request replaying its
  `Mcp-Session-Id` under a different principal gets `403`. Defense-in-depth on top
  of unguessable random session ids.
- **Binder must mutate only `sessionCtx` (R2-D1).** It receives a context parented
  on the live app context; reaching up to mutate the app would pollute the global
  (and unauthenticated) surface. Documented as a hard rule. `@authorize` and scope
  filtering still apply to session-local tools (verified).

## Testing

Spike already covers (4 passing, end-to-end over real HTTP):

- discovery isolation (Alice sees her tool, Bob does not);
- dispatch of a session-local tool through its own binding;
- a different user cannot call an undiscovered tool;
- shared app-level tools keep working for every session.

To add for production:

- **leak guard** — after a session `DELETE`/close, its `sessionCtx` is closed
  (assert via a close spy or a binding that observes disposal);
- **config resolution** — the per-session server reports the app-configured name;
- **composition with auth** — `strategyAuth`/OAuth principal drives `perUser`
  binding (bind a tool only for the `admin` token), and scope filtering still
  hides a scope-gated session-local tool;
- **concurrency** — two simultaneous sessions don't see each other's tools.

## Phasing

1. **Core** — `@inject.context()` in `MCPServer` (done; backward-compat verified).
2. **Transport** — `perUser` binder API + lifecycle in `@agentback/mcp-http`.
3. **Docs/tests** — README section (with the security warning), expanded suite.
4. **(Optional)** — an `examples/hello-mcp-multitenant` once the API settles.

## Open questions (resolved)

- _`perUser` vs `perSession`?_ → **`perSession`** (matches the unit; per-user intent
  in the JSDoc). Changed from the pre-review default after R3-A.
- _Object vs function option?_ → function (`SessionBinder`); `appContext` is a
  sibling internal option, eagerly validated.
- _Expose a typed principal to the binder instead of `req`?_ → keep `req`;
  `req.auth` is the canonical principal and avoids a second auth abstraction.
- _Throw or warn on `perSession` without auth?_ → **warn** (a gateway that
  authenticates upstream and passes a trusted, validated header is a legitimate
  pattern; a hard throw would break it). The footgun is closed structurally by the
  secure-only example + pinning instead.

## Follow-ups (not in this change)

- Idle/TTL session reaper (pre-existing transport-management gap; bounded at
  shutdown today).
- Relax the `@tool` "output requires input" overload so parameterless tools don't
  need `z.object({})`.
- `examples/hello-mcp-multitenant` once the API has soaked.
