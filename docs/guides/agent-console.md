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
- Bypass the permission prompt — the bridge forces `default` permission mode
  (`session/set_mode`), so file edits and shell commands always route
  `session/request_permission` to the user's dock card (live-validated).

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

## Permission prompts gate all file edits and shell commands

The bridge sets the ACP session to the `default` permission mode (via
`session/set_mode` immediately after `session/new`). In `default` mode,
`claude-agent-acp` routes every file write and shell command through
`session/request_permission` — live-validated against
`@agentclientprotocol/claude-agent-acp` 0.48 with real Claude auth.

The flow:

1. The agent emits `session/request_permission` to the bridge with the tool
   call and a list of permission options.
2. The bridge forwards the request as an SSE event to the browser dock.
3. The dock renders an **inline approval card** (never auto-dismissed).
4. The developer clicks one of the presented options (e.g. **Allow once**,
   **Allow always**, **Reject**).
5. The decision is sent back via `POST /console/chat/permission`.
6. A **deny** (`reject_once`) response blocks the write — the file is NOT
   created, and any follow-up bash workaround the agent attempts is itself gated
   by the same permission flow (live-validated: both the initial write and the
   bash workaround were blocked in sequence).

Permission option kinds observed in live validation: `allow_always`,
`allow_once`, `reject_once`. The `allow_always` option is **path + session
scoped** — the agent tracks it for the duration of the current session only;
there is no blanket persistent grant that survives a page reload or session end.

There is **no config flag** that bypasses this prompt. The `PermissionOptionKind`
values are decision types, not bypasses — the user makes each decision by
clicking a button on the dock's card.

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
| Permission prompts not bypassable | Bridge forces `default` mode via `session/set_mode`; dock UI (no config override) |
| Permission scope is path + session only | Dock UI (no persistent grants) |
| Node-host-only | `install()` no-ops (warning + return) on `listener:'native'` Edge hosts |
| No orphaned subprocesses | `disposeAll()` on `app.onStop()` + creation-TTL + SSE-disconnect lease GC |
| Introspection is read-only | `IntrospectionTools` (no invocation tools) |
| ACP adapter-isolated | All ACP glue in `acp-session.ts` |
| Agent editing root is server-controlled | `CHAT_WORKSPACE_ROOT` (config.workspaceRoot); client POST body cannot override it |

---

## workspaceRoot vs cwd

`chatConsoleFeature` accepts two distinct directory fields that are easy to
conflate:

| Field | Purpose | Who controls it |
|-------|---------|----------------|
| `cwd` | Adapter-discovery base dir — where `node_modules/.bin` is searched to find the `claude-agent-acp` bin at startup and at spawn | Server config |
| `workspaceRoot` | The coding agent's working/editing root — the ACP `session/new` cwd, where the agent reads and edits source files | Server config |

### `workspaceRoot` — agent editing root (security boundary)

`workspaceRoot` is passed directly to `AcpSession.open()` as the ACP
`session/new` cwd.  It is the tree the agent can edit and is therefore a
**security containment boundary**.  It is **server-controlled only** — the
client (browser dock's `POST /session` body) cannot set or override it.

- **Default**: `process.cwd()` — the directory the server process was launched
  from.  When launched from a monorepo root, this gives the agent visibility
  into the full repo (app + framework packages it depends on).
- **Standalone app**: set `workspaceRoot` to the app's own repo root so the
  agent is contained to the service's codebase.
- **Monorepo**: leave unset (or set to the repo root) so the agent can evolve
  both the app's code and the framework packages in a single session.

```ts
chatConsoleFeature({
  enabled: true,
  cwd: import.meta.dirname,       // adapter-discovery: this example's dir
  workspaceRoot: '/my/project',   // agent edits files here (server-controlled)
})
```

### `cwd` — adapter-discovery base (spawn PATH)

`cwd` is only used to augment `PATH` when probing for and spawning the ACP
adapter binary.  When the adapter is a `devDependency` of your app package,
set `cwd` to `import.meta.dirname` (the app's source dir) so pnpm's isolated
`node_modules/.bin` is walked.  This has no effect on where the agent edits
files.

When both are needed, set them independently:

```ts
chatConsoleFeature({
  enabled: true,
  cwd: import.meta.dirname,         // adapter-discovery: finds the bin here
  workspaceRoot: repoRoot,          // agent editing root: broader or narrower
})
```

---

## Installing the ACP adapter

`claude-agent-acp` (from `@agentclientprotocol/claude-agent-acp`) is the
blessed reference adapter.  You can install it in two ways:

**Option A — Global install** (available to all projects on the machine):

```bash
npm install -g @agentclientprotocol/claude-agent-acp
```

**Option B — Project devDependency** (no global install required):

Add it to your app's `package.json` `devDependencies`:

```json
{
  "devDependencies": {
    "@agentclientprotocol/claude-agent-acp": "^0.48.0"
  }
}
```

Then `pnpm install` (or `npm install`).  The discovery probe and the spawn
both augment `PATH` with the local `node_modules/.bin` directories walked up
from `process.cwd()`, so `claude-agent-acp` is found without a global install.
pnpm may hoist the binary to the workspace root's `node_modules/.bin` or keep
it under the package's own `node_modules/.bin` — both are covered.

**Doctor fix hint:** when the `GET /console/chat/agents` probe returns `{status:
'missing'}`, the `fix` field contains `npm install -g
@agentclientprotocol/claude-agent-acp`.  You can use the global form **or**
add the package as a devDependency in your project (Option B) — either makes
the adapter discoverable at startup.

Other agents can be configured via `chatConsoleFeature({agents: [...]})` but
are "advanced/custom" — the built-in doctor only knows the reference adapter's
install path.

---

## Live reflection

When your app restarts — e.g. the agent (or you) edits source and `build:watch`
rebuilds — the open console panels refresh automatically to show the new
structure. No configuration: it is on whenever the console is mounted.

How it works: the console serves a per-process boot id over a `GET
<basePath>/live` SSE stream. The client keeps that stream open; when a
reconnect returns a *new* boot id (the process restarted), the native explorers
(`context-explorer`, `schema-explorer`) refetch in place — your current
selection and filters are preserved — and the embedded panels (`rest-explorer`,
`mcp-inspector`) remount with fresh data. A transient network blip reconnects to
the *same* boot id and is ignored. A small "offline" indicator appears in the
sidebar while the stream is down. Node-host-only; SSE (no WebSocket).

This closes the **evolve → see** loop in the agent console workflow: the coding
agent (dock) edits source → the app rebuilds → the explorer panels refresh
automatically to reflect the new structure, with no manual reload required.

---

## ACP experimental status

The ACP protocol (`@agentclientprotocol/sdk`) is experimental and evolving.
The pinned SDK version and all ACP-specific code live in `acp-session.ts`;
protocol churn touches one file. The `ACP-NOTES.md` in `packages/console-chat`
documents the pinned API surface and known validation gaps.
