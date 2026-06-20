# Agent Console Security Guide

**Package:** `@agentback/console-chat`  
**Risk level:** High — the feature spawns a coding agent subprocess that can
write files and run shell commands, reachable over HTTP.

This guide covers the security model, required configuration, threat surface,
and the invariants that are enforced by the framework vs. the ones that depend
on operator configuration.

---

## What this feature does

The agent console dock spawns a **locally-installed ACP coding agent** as a
subprocess, wires it to the live AgentBack app's MCP surface (including the
read-only `IntrospectionTools`), and bridges it to the browser via SSE + POST.
The agent can:

- Read the live app: bindings, schema, routes, tools, OKF bundle.
- **Edit source files** under the developer's permission approval.
- **Run shell commands** under the developer's permission approval.
- Call the app's own MCP tools (the business MCP surface, if wired).

It **cannot** (framework invariants):

- Call routes or tools via the introspection surface — the introspection MCP
  is read-only and contains no invocation tools.
- Bypass the permission prompt — file edits and shell commands always surface
  `session/request_permission` to the user.

---

## Off by default

The dock and all its bridge endpoints are **absent unless explicitly enabled**:

```ts
chatConsoleFeature({enabled: true})
```

With `enabled: false` (the default), `chatConsoleFeature().install()` returns
immediately — no controller registers, no HTTP endpoints exist. The dock does
not render in the browser.

---

## Dock visibility gate

Even when `enabled: true`, the dock does **not render** in the browser unless
at least one ACP agent is discovered via PATH probe at startup. Discovery is
a read-only `which`/`--version` check; the dock stays hidden (an optional
"install hint" is shown) when the probe returns nothing.

This means a misconfigured server that has `enabled: true` but no agent installed
renders a static install hint — no attack surface beyond the install message.

---

## All bridge endpoints require authentication

Every request to `/console/chat/*` goes through the same `auth` middleware
passed to `installConsole`. Unauthenticated sessions are rejected with `401`
at two layers:

1. **Express middleware** — the `auth` handler runs before any route handler.
2. **Per-request principal check** — the `auth` middleware **MUST** set
   `req.auth` to an object with a stable principal id before calling `next()`.
   Both the SSE stream (`GET /console/chat/stream`) and all `@api` POST/DELETE
   endpoints derive the principal from `req.auth` via the same
   `principalFromRequest` helper. Missing or empty `req.auth` → `401
   unauthenticated`.

The `principalFromRequest` helper accepts two `req.auth` shapes:
- **`AuthInfo`** (from `@modelcontextprotocol/sdk`): reads `clientId`. This is
  what `frameworkAuthGuard` (from `@agentback/mcp-http`) produces.
- **`UserProfile`** (from `@agentback/security`): reads `[securityId]`. Custom
  middleware may set this shape.

Sessions are **bound to the authenticated principal**. A session started by
principal A cannot be accessed by principal B.

---

## Loopback-only without real auth

`unsafeAllowUnauthenticated: true` is a legacy escape hatch that disables the
outer `auth` middleware gate entirely. It does **not** set `req.auth`, so the
bridge's per-request principal check still fires — every bridge endpoint still
returns `401` because `req.auth` is absent. **It is effectively useless for the
bridge** without a companion middleware that sets `req.auth`.

For local development, provide a loopback-only `auth` middleware that both gates
the console and sets `req.auth` to a fixed local principal. The
`hello-agent-console` example ships a minimal `devLoopbackAuth` middleware that
does exactly this (see `examples/hello-agent-console/src/index.ts`):

```ts
function devLoopbackAuth(req, _res, next) {
  req.auth = {token: 'dev-loopback', clientId: 'local-dev', scopes: []};
  next();
}

await installConsole(app, {
  features: [...defaultFeatures(), chat],
  auth: devLoopbackAuth, // DEV ONLY — replace with real auth for non-loopback
});
```

**Never use a loopback-only auth middleware with a non-loopback bind.**

The consequence: a process-spawning HTTP endpoint is exposed to any machine
that can reach your server with no authentication. That is a remote code
execution vector.

For any deployment beyond loopback:

1. Provide a real `auth` middleware that validates credentials (JWT, session
   cookie, API key, etc.) and sets `req.auth` with a stable principal id.
2. Leave `unsafeAllowUnauthenticated` unset (or `false`).
3. Consider running the server on a non-routable interface (VPN, localhost
   tunnel) rather than a public address.

---

## Permission prompts are not bypassable from config

When the ACP agent wants to write a file or run a shell command, it emits
`session/request_permission`. The bridge:

1. Forwards the request as an SSE event to the browser dock.
2. The dock renders an **inline approval card** (never auto-dismissed).
3. The developer clicks **Approve** or **Deny**.
4. The decision is sent back via `POST /console/chat/permission`.

There is **no config flag** that bypasses this prompt. The ACP protocol's
`PermissionOptionKind` values (`allow_once`, `allow_always`, `reject_once`,
`reject_always`) are decision types, not bypasses — the user still makes each
decision by clicking a button.

The dock exposes a **path + session scoped** "Allow edits in `src/` for this
session" checkbox. Its scope is:

- **Path-scoped**: only covers files under the given prefix.
- **Session-scoped**: expires when the session ends or the page reloads.

There is no "always allow globally" affordance. The framework does not persist
any permission grants across sessions.

---

## Node-host-only

Spawning a subprocess requires `node:child_process`, which is unavailable on
`EdgeRestApplication` (Workers/Bun/Deno environments). If `chatConsoleFeature`
is installed on an Edge app, `install()` detects `server.listener === 'native'`,
logs a warning via `loggers`, and **returns without mounting anything** — a
genuine no-op. The bridge endpoints and controller do not register. No error is
thrown.

---

## Session lifecycle and subprocess cleanup

Each ACP session owns a subprocess. When a session ends — by:

- `DELETE /console/chat/session` (explicit stop),
- SSE client disconnect (after the 30 s reconnect lease expires),
- Never-subscribed TTL (see below), or
- Server shutdown (`app.stop()`) —

the bridge kills the subprocess and removes the session from the map. **No
orphaned processes.** The bridge uses `SpawnError`, `AcpHandshakeError`, and
`PartialTurnError` for named error states; there is no silent catch-all that
could leave a subprocess running.

### Server shutdown → kills the subprocess / no orphaned processes

`chatConsoleFeature().install()` wires `app.onStop(() => controller.disposeAll())`
before `app.start()`. When the application stops, `disposeAll()` iterates the
full session map, calls `dispose()` on every `AcpSession` (which kills the
subprocess), and clears the map. All pending creation-TTL timers are also
cancelled at that point.

### Creation-time TTL: never-subscribed sessions

A session created via `POST /session` but never connected via
`GET /stream?sessionId=…` would otherwise leak indefinitely — the
SSE-disconnect handler never arms if the client never subscribes.

To close this gap, `createSession` starts a timer (30 s, the same window as
the SSE reconnect lease). If no SSE stream subscribes within that window, the
session is automatically disposed and removed from the map. When an SSE client
does subscribe, `handleSseRequest` cancels the timer immediately — normal
sessions are unaffected.

---

## Introspection grounding is read-only

The agent session registers the app's `/mcp` endpoint (which carries both the
business tools and the `IntrospectionTools` surface) as an MCP server. The
`IntrospectionTools` tools (`inventory`, `get`, `get_okf_bundle`) return
**metadata only**:

- `inventory` returns keys, kinds, scopes, tags, and source — never values.
- `get` for a binding returns the same metadata set — it **never resolves the
  binding's value** and never exposes secrets or instance data.
- `get_okf_bundle` returns the static OKF snapshot — schema-indexed docs, not
  runtime state.

No `call_route` or `call_tool` MCP tool exists or will be added to this
surface. The read-only invariant is enforced in `IntrospectionTools` (see
`packages/introspection`) and is documented as permanent.

---

## Summary checklist

| Invariant | Enforced by |
|-----------|-------------|
| Off by default | `chatConsoleFeature({enabled: false})` (default) |
| Dock hidden until agent discovered | Discovery probe in `feature.ts` |
| All endpoints require auth | `auth` middleware + per-request `principalFromRequest` check |
| No anonymous sessions | `401` when `req.auth` absent or yields no principal id |
| `auth` middleware MUST set `req.auth` | `principalFromRequest` reads `AuthInfo.clientId` or `UserProfile[securityId]` |
| Loopback-only without real auth | Operator configuration (dev loopback `auth` middleware) |
| Permission prompts not bypassable | ACP protocol + dock UI (no config override) |
| Permission scope is path + session only | Dock UI (no persistent grants) |
| Node-host-only | `install()` no-ops (warning + return) on `listener:'native'` Edge hosts |
| No orphaned subprocesses | `disposeAll()` on `app.onStop()` + creation-TTL + SSE-disconnect lease GC |
| Introspection is read-only | `IntrospectionTools` (no invocation tools) |
| ACP adapter-isolated | All ACP glue in `acp-session.ts` |

---

## ACP experimental status

The ACP protocol (`@agentclientprotocol/sdk`) is experimental and evolving.
The pinned SDK version and all ACP-specific code live in `acp-session.ts`;
protocol churn touches one file. The `ACP-NOTES.md` in `packages/console-chat`
documents the pinned API surface and known validation gaps.

`claude-agent-acp` is the blessed reference adapter. Other agents can be
configured via `chatConsoleFeature({agents: [...]})` but are "advanced/custom"
— the built-in doctor only knows the reference adapter's install path.
