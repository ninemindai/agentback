# @agentback/console-chat

**The "see and evolve" agent dock for the AgentBack developer console.**

A side panel in the unified `/console` shell that fronts an **ACP (Agent Client
Protocol) coding agent** — grounded in your live running app — so you can ask
it questions about the app _and_ have it evolve the source. Two verbs,
deliberately separated:

- **See** — the agent reads the live app (bindings, schema, routes, tools) via
  `@agentback/introspection` before it answers; no guessing from stale source.
- **Evolve** — the ACP agent edits source files under its own permission model
  (approve/deny each file write or shell command); the framework adds no
  mutation tools.

The dock is **off by default** and **Node-host-only** (it spawns a subprocess).
It does not render unless `chat.enabled` is `true` _and_ at least one ACP
agent is discovered on `PATH`. On `EdgeRestApplication` the feature is absent.

> **Phase 2 of the console-chat ACP plan.** The read-only `@agentback/introspection`
> package (Phase 1) ships the grounding surface standalone; this package adds the
> dock that drives a coding session from within the console.

---

## Quick start

```bash
npm install @agentback/console @agentback/console-chat
```

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {IntrospectionTools} from '@agentback/introspection';
import {installConsole, defaultFeatures} from '@agentback/console';
import {chatConsoleFeature} from '@agentback/console-chat';

const app = new RestApplication();
app.component(MCPComponent);
app.service(IntrospectionTools);     // grounding: agent sees the live app
await installMcpHttp(app);           // serves MCP (incl. introspection) at /mcp

const chat = chatConsoleFeature({
  enabled: true,
  introspection: true,               // ground the session via IntrospectionTools
});

await installConsole(app, {
  features: [...defaultFeatures(), chat],
  unsafeAllowUnauthenticated: true,  // local dev only — use real auth otherwise
});

await app.start();
// Console: http://localhost:3000/console (agent dock in right column)
// MCP:     http://localhost:3000/mcp
```

Open `/console` — the dock appears in the right column when `claude-agent-acp`
(or another configured agent) is found on `PATH`. The agent picker defaults to
the first discovered agent. Ask it anything about your running app; it can call
`inventory` / `get` / `get_okf_bundle` live.

---

## What you get

- **Agent picker** — built-in catalog detects `claude-agent-acp`; custom agents
  extend it via `config.agents`.
- **Streaming conversation** — assistant text, tool-call activity blocks (with
  `▸ inventory(…)` mono lines), and plan updates, all rendered inline.
- **Navigation-focus chip** — when you navigate to a schema entity, binding, or
  route in the explorers, a dismissible context chip appears above the composer
  so the next message implicitly scopes to it.
- **Permission prompts** — file edits and shell commands surface an inline card
  (rust left border, `path · +N −M`) with **Approve** / **Deny**. A
  path+session-scoped checkbox lets you remember the choice for that path within
  the current session; no blanket "always allow."
- **Doctor / F1** — when the agent binary is missing or the wrong version, the
  dock shows the exact `npm install -g …` fix line.
- **Rebuild affordance / F5** — after the agent edits source, the dock surfaces
  "Rebuild & reconnect." Where `build:watch` is running, it detects the restart
  and re-grounds the session.

---

## Bridge endpoints

All endpoints are registered under `/console/chat` and gated behind the console
`auth` middleware.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/console/chat/agents` | Discovered ACP agents `{id, name}[]` for the picker |
| `POST` | `/console/chat/session` | Start a session `{agentId}` → `{sessionId}` |
| `GET`  | `/console/chat/stream?sessionId=…` | SSE: assistant deltas, tool activity, permission requests, lifecycle |
| `POST` | `/console/chat/message` | Send a user turn `{text, focus?}` |
| `POST` | `/console/chat/permission` | Resolve a pending permission `{requestId, outcome}` |
| `DELETE` | `/console/chat/session` | Stop the session and kill the subprocess |

All requests require an authenticated principal (`SecurityBindings.USER`);
unauthenticated calls receive `401`.

---

## Configuration

```ts
chatConsoleFeature({
  enabled: true,          // gate the dock (default: false)
  cwd: '/my/project',     // subprocess working dir (default: process.cwd())
  introspection: true,    // inject IntrospectionTools as a grounding server (default: true)
  agents: [               // add to the built-in catalog
    {
      id: 'my-agent',
      name: 'My Agent',
      detect: {bin: 'my-agent', minVersion: '1.0.0'},
      command: ['my-agent', '--acp'],
    },
  ],
})
```

`installConsole` reads the `chatConfig` property from the feature via duck-
typing — no direct import from `@agentback/console-chat` in `@agentback/console`
(avoids the circular dep).

---

## Dependency direction

```
@agentback/console-chat  →  @agentback/console   (runtime dep)
@agentback/console       ←  @agentback/console-chat  (devDep: SPA bundle only)
```

`@agentback/console`'s server code **never imports** `@agentback/console-chat`.
The chat config is communicated via the duck-typed `chatConfig` property on
`ConsoleFeature`. The SPA bundle (`main.tsx`) dynamically imports the dock at
runtime, so the browser code also avoids a build-time circular dep.

---

## Security

> This feature spawns a subprocess that can write files and run shell commands,
> reachable over HTTP. Read the full security model before exposing it.

- **Off by default.** No bridge endpoints are registered unless `enabled: true`.
- **Behind console auth.** All `/console/chat/*` endpoints go through the same
  `auth` middleware as the rest of the console.
- **Loopback-only for unauthenticated setups.** `unsafeAllowUnauthenticated: true`
  is for local development only; never expose a process-spawning chat endpoint
  beyond the loopback interface without real auth.
- **No anonymous sessions.** Every session is bound to `SecurityBindings.USER`
  (the authenticated principal). The SSE stream rejects `401` if no user is set.
- **Permission prompts are not bypassable from config.** File edits and shell
  commands always surface `session/request_permission` to the user; the dock
  renders the approve/deny card. The only "remember" scope is path + current
  session.
- **Node-host-only.** `EdgeRestApplication` cannot spawn subprocesses; the
  feature is absent there by design.

See `docs/guides/agent-console.md` for the full security guide.

---

## Layering

```
@agentback/console-chat
  ↳ chatConsoleFeature()  — ConsoleFeature + chatConfig
  ↳ ChatBridgeController  — REST endpoints
  ↳ AcpSession            — ACP SDK client (spawn + stream + permission)
  ↳ agents.ts             — built-in catalog, discoverAgents, doctor
@agentback/introspection  — grounding (read-only MCP tools)
@agentback/console        — shell that reads chatConfig via duck-typing
```

See `examples/hello-agent-console` for a runnable wiring.
