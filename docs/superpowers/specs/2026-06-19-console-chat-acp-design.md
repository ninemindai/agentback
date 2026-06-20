# Console Chat (ACP) — Design

**Date:** 2026-06-19
**Status:** Design — pending implementation plan
**Package:** `@agentback/console-chat` (new, Node-host-only)

## Intent

A dev experience to **see and evolve the application with a coding agent.**
Two verbs, cleanly separated: **see** = read-only introspection grounding (the
agent understands the live app); **evolve** = the ACP coding agent edits the
repo's source and you rebuild. Evolution happens through *source edits* (the
agent's native capability), not through MCP mutation tools — so the introspection
surface stays read-only forever and the two halves never contend over a mutation
gate. "Evolve" is the point of the feature; "see" is the foundation that makes the
agent's edits well-grounded.

## Summary

Add an **agent chat dock** to the unified console (`/console`): a side panel,
co-visible with the existing explorers, that fronts an **agentic coding session**
grounded in the live AgentBack app. The chat is a thin web frontend over an
**ACP** (Agent Client Protocol) agent the console launches as a subprocess; the
framework ships **no model and no keys**. The agent is grounded in the running
app two ways — a standing **OKF brief** injected at session start, and a live
**introspection MCP** the agent queries mid-conversation — and its context
follows **console navigation** (what you're looking at becomes ambient context
on your next message).

This is the one console feature that intentionally **extends the shell** (the
existing panels are mutually-exclusive routes; the chat is a persistent dock)
and is **Node-host-only** (it spawns a subprocess; not available on
`EdgeRestApplication`).

## Decisions (locked)

1. **Audience/target — both, one panel.** A single chat grounded in the live app
   (MCP / context / schema / api) that can also touch source code when present,
   degrading gracefully when it isn't.
2. **Runtime — ACP-only; panel hides when absent.** Framework ships zero
   model/keys. Pure web frontend over an externally-supplied ACP agent. When no
   agent is **discovered or configured**, the dock does not render. Consistent
   with the project's bring-your-own posture (auth server,
   payments-authorize-not-settle).
3. **Grounding — OKF brief + introspection MCP.** Inject the OKF bundle as the
   session's standing context, AND expose the four explorers' read APIs as live
   MCP tools the agent can query on demand. Static map + live drill-down.
   **The introspection MCP is split by phase (see Phasing): read-only + redacted
   in Phase 1; live mutation (`call_route`/`call_tool`) only in Phase 2 behind the
   permission UI.**
4. **Bridge topology — console discovers + launches the agent.** The console
   server **discovers locally-installed ACP agents** (PATH probe against a
   built-in catalog, plus any custom agents from config), presents them as
   **choices** in the dock, and spawns the **selected** agent as a subprocess,
   wiring it to the grounding and bridging it to the browser. "Absent" = no agent
   discovered and none configured.
5. **Layout — side dock (shell extension), navigation-driven context.** The chat
   is a persistent dock alongside the active panel. A structured **focus
   descriptor** published by each panel becomes a dismissible context chip the
   dock attaches to the next message.
6. **Transport — SSE + POST, mirroring `mcp-http`.** Server→client streaming over
   SSE; client→server (messages, permission responses) over POST. **No
   WebSocket** — it doesn't fall out of the Zod/OpenAPI/MCP projection thesis,
   fights edge portability, and isn't needed here. A raw-`upgrade` WS escape hatch
   is a possible *future* Node-only addition, explicitly out of scope now.

## Phasing (CEO review, 2026-06-20 — SELECTIVE EXPANSION)

The original spec welded a durable primitive (live-app introspection an agent can
consume) to a risky presentation layer (an ACP coding agent driven from a spawned
subprocess). The CEO review split them and sequenced delivery (Approach C):

- **Phase 1 — Introspection MCP (standalone, low-risk, ships first).**
  A **standalone, externally-documented package** (own README + `docs/` + skill
  entry) exposing the live app to **any** agent — your terminal Claude Code,
  Cursor, an A2A peer — over `mcp-http` (and optionally stdio), not just the
  console. **Read-only + redacted:** `list_bindings`/`get_binding` return
  **metadata only** (key/scope/type/tags/source), reusing context-explorer's
  metadata-only builder and honoring the `context-explorer/src/model.ts:150`
  invariant ("NEVER resolves a binding value"); plus `get_schema_graph`,
  `get_entity`, `list_routes`, `list_tools`, `get_okf_bundle`. **No value
  resolution, no invocation.** Edge-safe. This is the differentiated value
  (live-runtime grounding for the agent you already use) and lands without the
  dock.
- **Phase 2 — ACP dock (the "evolve" half; builds on Phase 1).**
  The shell dock + ACP bridge + agent discovery + nav-context. **Evolution =
  the ACP coding agent editing source files** under its own permission model;
  the framework does not add MCP mutation tools. The introspection MCP stays
  read-only. Node-host-only. (The earlier "metering/audit per mutation" cherry-
  pick is largely moot once mutation tools are dropped — source edits are
  audited by git; if the app's *business* MCP tools are invoked by the agent,
  those already flow through the app's own auth + any metering it has.)

Rationale: the durable primitive proves itself (and survives ACP protocol churn)
before committing to the fast-moving bridge; each phase is a right-sized,
value-delivering diff; the biggest risk (spawn-a-shell + mutation over HTTP) is
isolated to Phase 2 and never ships ungated.

### Plan notes (fold into implementation)

- **Named bridge errors (Phase 2), no catch-all.** `SpawnError` (ENOENT / bad
  command → dock "agent failed to start"), `AcpHandshakeError` (timeout / version
  mismatch → dock + fall back to picker), `PartialTurnError` (agent dies mid-turn
  → mark turn failed, surface). SSE disconnect / agent EOF must **tear down the
  session and kill the subprocess** (no orphan).
- **OKF brief size.** Large apps → inject a summary + `get_okf_bundle` on demand
  rather than the full bundle up front.
- **Nav-focus staleness.** The dock must clear the focus chip when the source
  panel's selection changes, never ship a stale descriptor.
- **DRY.** Introspection tools wrap the explorers' existing `lib`/`model.ts`
  builders; never re-walk the container.
- **Design review.** Run `/plan-design-review` before Phase 2 (dock state map:
  loading / empty=no-agent / error=agent-crashed / streaming / permission-prompt /
  partial-turn) — not needed for Phase 1 (no UI).

## Architecture

Follows the console's existing two-sided composition contract (a client
`./console` entry exporting `pages`/dock registration + a server
`ConsoleFeature`), with one addition: a **shell dock slot**.

### Shell extension (in `@agentback/console` + `@agentback/console-theme`)

- The shell gains a **right-dock region** alongside the left-nav + main-panel
  layout. The dock is owned by the shell; `console-chat` fills it. This is a
  deliberate, one-time shell capability — the README's "no shell changes to add a
  panel" invariant still holds for *route* panels; the dock is a new, separate
  extension point.
- A small **navigation-focus context** (shared client event/store): each panel
  may publish a structured descriptor of what's currently focused, e.g.
  `{kind:'schema-entity', name:'Greeting'}`,
  `{kind:'binding', key:'CoreBindings.FETCH'}`,
  `{kind:'route', method:'GET', path:'/hello/{name}'}`,
  `{kind:'tool', name:'forecast'}`. The dock subscribes; navigation updates the
  chip, it does **not** start a new turn.

### Agent discovery & catalog (console-owned)

- The package ships a **built-in catalog** of known ACP agents, each a descriptor:
  `{id, name, detect, command}` — `detect` is a read-only probe (binary on PATH
  via `which`, optionally a `--version`/capability check), `command` is the
  per-agent ACP launch spec (e.g. the `claude-agent-acp` adapter, **not**
  `claude-code --acp`). Per-agent
  invocation variance lives here, in data, not in the bridge.
- Config may **register custom agents** (same descriptor shape) to extend the
  catalog for agents the built-in list doesn't know.
- On request the server runs each descriptor's `detect` probe and returns the
  **present** agents as choices. Discovery is read-only and outside the
  security-gated surface; only *launching* a chosen agent is gated.
- The dock renders when **≥1 agent is discovered (or a custom one is
  configured)**. Zero → dock hidden (optionally an install hint in dev).

### Client — `@agentback/console-chat/console`

- Registers the **chat dock** (not a routable page). Renders only when
  `window.__CONSOLE__.chat.enabled` is true (i.e. ≥1 agent available).
- Presents a **picker** of discovered agents; the chosen agent's `id` is sent on
  session start. Remembers the last choice.
- Holds the SSE connection (assistant tokens, tool-call activity, plan updates,
  permission requests) and POSTs user messages + permission responses.
- Maintains the **current focus** from the navigation-focus context and renders a
  dismissible "context: `Greeting` entity" chip; attaches the focus descriptor as
  an ambient context block on the next outgoing message.
- Renders: streamed assistant text, tool-call activity (incl. introspection-MCP
  calls), the agent plan, and **permission prompts** (approve/deny) for file
  edits / shell.

### Server — `chatConsoleFeature()` in `@agentback/console-chat`

A `ConsoleFeature` that registers an `@api` controller owning the bridge and
advertises the dock's config into `window.__CONSOLE__.chat`.

Endpoints (all behind the console's existing `auth` middleware):
- `GET  …/chat/agents` — discovered ACP agents (`{id, name}`) for the picker.
- `GET  …/chat/stream` — SSE: server→client events (assistant deltas, tool
  activity, plan, permission requests, session lifecycle).
- `POST …/chat/message` — a user turn `{text, focus?}`; focus is the ambient
  context descriptor.
- `POST …/chat/permission` — `{requestId, outcome}` answering an ACP
  `session/request_permission`.
- `POST …/chat/session` — start a session `{agentId}` (one of the discovered
  agents); `DELETE …/chat/session` stops it.

**ACP session lifecycle:**
1. On session start, resolve `agentId` to its catalog descriptor and **spawn** its
   `command` as a subprocess with `cwd` = project root (where source lives), then
   run the ACP `initialize` handshake.
2. Register **two MCP servers** with the session:
   - the app's own **`mcp-http`** URL (business tools — what "talk to the running
     app" means), and
   - the console-owned **introspection MCP** (below), kept **separate** so
     dev-introspection tools never leak into the app's production tool surface or
     OKF bundle.
3. Inject the **OKF brief** (`GET /schema-explorer/api/okf`) as standing session
   context.
4. Relay `session/prompt` → stream `session/update` back over SSE.
5. Forward `session/request_permission` over SSE; return the user's decision via
   the `…/chat/permission` POST.

### Introspection MCP (console-owned)

A dev-scoped MCP server wrapping the explorers' existing `@api` builders.
**Phase 1 (read-only + redacted) — consolidated selector surface (CEO Tension B
resolved):** three tools, not seven, so the surface is small, agent-legible, and
doesn't duplicate the explorer models.
- `inventory(kind?)` — unified node list across kinds (`binding` | `schema-entity`
  | `route` | `tool`); `kind` filters. Bindings are **metadata only** (key/scope/
  type/tags/source) via context-explorer's metadata-only builder — never a value.
- `get(selector)` — fetch one node's detail by a typed selector `{kind, id}`
  (binding metadata, schema-entity fields, route detail, tool input/output schema).
  The selector is the **same shape as the dock's focus chip**, so `get(focusChip)`
  is the natural pivot.
- `get_okf_bundle()` — the standing brief on demand (summary + full per F-note).

Rationale: the 7 named read tools were thin wrappers that duplicated explorer
models; a selector pair + OKF is easier for an agent to discover and call, and
measures usage before any expansion. No value resolution, no invocation.

**The introspection MCP is read-only forever.** No `call_route`/`call_tool`.
(Resolved: CEO Tension A + the stated intent.) "Evolve the application" happens
through the **ACP coding agent editing source files** (its native capability,
under its own permission model), not through framework-mediated MCP mutation.
This dissolves the fake "permission UI gates MCP calls" problem (the ACP
permission channel can't intercept MCP calls anyway) and the SSRF-shaped
`call_route` shadow API. Intentional agent *actions* against the running app, if
ever wanted, go through the app's **existing business MCP** (its own auth), not a
generic invoker. The audit trail for evolution is **git**, not the framework.

Because the focus chip is a structured descriptor, the agent pivots from it
straight into these tools (chip `schema-entity: Greeting` → `get_entity('Greeting')`).

## Data flow (one turn)

1. User navigates the console → active panel publishes a focus descriptor → dock
   updates the context chip.
2. User sends a message → `POST …/chat/message {text, focus}` → bridge →
   ACP `session/prompt` (focus attached as an ambient context block).
3. Agent streams `session/update` (assistant deltas, tool calls, plan) → bridge →
   SSE → dock renders incrementally.
4. Tool call:
   - introspection MCP / business MCP → served live from the app, result streamed
     back as tool activity;
   - file edit / shell → agent emits `session/request_permission` → SSE → dock
     shows approve/deny → `POST …/chat/permission` → agent proceeds or aborts.

## Security model (load-bearing)

A chat that spawns a coding agent with filesystem-write + shell, reachable over
HTTP, is a **remote-code-execution surface**. Non-negotiable constraints:

- **Off by default.** The dock exists only when chat is enabled and ≥1 agent is
  available. Discovery itself is a read-only PATH probe; **launching** a chosen
  agent is the gated action. With chat disabled, no bridge endpoints register.
- **Behind console `auth`.** All bridge endpoints go through the same `auth`
  middleware as the rest of the console.
- **Never under `unsafeAllowUnauthenticated` when remotely bound.** The
  local-dev unauthenticated opt-in must not expose a process-spawning chat to a
  non-loopback interface. Default bind is loopback; exposing chat beyond loopback
  requires real `auth` and an explicit, separate opt-in.
- **Node-host-only.** Spawning a subprocess is unavailable on
  `EdgeRestApplication`; documented, and the feature no-ops (stays absent) there.
- **Permission prompts are not bypassable from config** — file edits / shell
  always surface the ACP permission request to the user.

## Configuration

Extend `installConsole` options:

```ts
installConsole(app, {
  // …existing…
  chat: {
    enabled: true,        // gate the feature on (default: false)
    cwd,                  // default: project root
    introspection: true,  // default: true
    agents: [             // OPTIONAL custom agents, added to the built-in catalog
      {id: 'my-agent', name: 'My Agent',
       detect: {bin: 'my-agent'}, command: ['my-agent', '--acp']},
    ],
    // business MCP (app's own mcp-http) auto-wired when mcp-http is installed
  },
});
```

Discovered agents = built-in catalog ∪ `chat.agents`, filtered by `detect`.
Absent `chat`, `chat.enabled: false`, or zero discovered agents → dock hidden, no
bridge endpoints.

## Scope

**Phase 1 — Introspection MCP (build first; standalone, read-only, edge-safe):**
- Standalone introspection MCP package: read-only + redacted **selector surface**
  — `inventory(kind?)`, `get(selector)`, `get_okf_bundle()` — wrapping the
  explorers' existing builders. Bindings metadata-only. No value resolution, no
  invocation.
- Served over `mcp-http` (and optionally stdio) so any external agent connects.
- Doc surfaces: package README, `docs/packages.md`, the agent SKILL, `CLAUDE.md`
  capability list; an `examples/hello-*` wiring it to an external agent.
- In-process MCP-client tests incl. the hostile "no value leaks from
  `get_binding`" assertion.

**Phase 2 — ACP dock (build second; Node-only, on top of Phase 1):**
- Agent discovery (built-in catalog + custom) + dock picker.
- Shell dock slot + navigation-focus context.
- ACP bridge over SSE+POST: spawn, initialize, prompt, streaming, permission
  prompts, session lifecycle, named errors (no catch-all), no orphaned subprocess.
- Evolution via the ACP coding agent editing source (its own permission model);
  no framework MCP mutation tools. Introspection MCP stays read-only.
- Grounding wiring: OKF brief at session start + per-message ambient focus chip.
- Config + hide-when-absent + the full security model; Node-host-only.
- `/plan-design-review` before implementation (dock state map).
- On-ramp example booting the console with `chat.enabled`.

**Tier 2 — later:**
- Rich rendering: file-edit diffs; tool results that link back into the relevant
  console panel (a referenced entity → click into schema-explorer).
- "Ask about this" affordances from each panel that seed a message into the dock.
- **Live reflection (agent-as-acting-peer).** When the agent mutates state via a
  tool (`call_route`/`call_tool` or a business MCP tool), the open explorer panels
  refresh so the human sees the change immediately — the dev-console echo of
  agent-native's "one state, humans and agents edit together." Drive it off the
  existing `actors`/`messaging` event subscriptions rather than polling.

**Tier 3 — later:**
- Agent-driven console navigation (agent focuses a panel for you).
- Multi-session / session history.

## Developer experience (DX review, 2026-06-20)

Persona: the **AgentBack app author** building their own service, using the
console + agent to *see and evolve* it. TTHW that matters = **time-to-first-
grounded-answer** (agent demonstrably knows the live app), target 2-5 min.

- **F1 — One pinned reference adapter + doctor (Phase 2).** Support **one**
  blessed ACP adapter (`claude-agent-acp`) end to end. The dock detects it and,
  if missing/wrong-version, shows a copy-paste install line + a doctor check
  ("found / not found / wrong version") with the exact fix. Other agents are
  "advanced/custom". This is the TTHW make-or-break: never leave "connect your
  agent" to a docs round-trip. (Every error = problem + cause + fix.)
- **F5 — Honest evolve→see loop (Phase 2).** Don't fake live source reload. After
  the agent edits source, the dock shows a clear "rebuild to see changes"
  affordance; where a `build:watch` is running, detect the restart and reconnect,
  re-grounding the session. Sets the true expectation: evolve = edit + rebuild.
- **F2 — One copy-paste onboarding block.** The Phase 1 README and the example
  must hit "agent sees my app" in a single copy-paste block matching the
  `packages/mcp-http/README.md` shape (value prop → rationale → install → what
  you get). More moving parts than mcp-http; the docs must hide that.
- **F3 — Example name.** `examples/hello-chat` already exists. Name the on-ramp
  example distinctly (e.g. `hello-agent-console`) to avoid discoverability
  collision.

## Out of scope

- First-class, Zod-projected **WebSocket** API surface (deferred; future Node-only
  raw-`upgrade` escape hatch if a real need appears).
- Framework-embedded agent / model / keys (ACP-only; bring your own agent). This
  is the deliberate boundary that distinguishes AgentBack from full agent-runtime
  frameworks (e.g. BuilderIO/agent-native) that bundle model/keys/host.
- Edge-host chat.
- Any change to the existing explorers' read APIs beyond wrapping them as
  introspection MCP tools.

### Related / future (not this build)

- **A2A agent-peer surface.** A separate, complementary direction: expose
  AgentBack's *own* tools as an **A2A** (Agent2Agent) -callable peer so *other*
  agents can invoke this app (sibling to `mcp-host`/`mcp-connect`). Distinct from
  console-chat, which is the **ACP** shape — *our console drives a local coding
  agent*. A2A is *other agents call our app*. Noted because agent-native chose A2A
  for its peer-coordination; it is not a reason to change console-chat's transport.

## Risks / open questions

- **ACP maturity & agent coverage.** ACP is young and agent-specific. Need a
  reference agent (the `claude-agent-acp` adapter) to validate the handshake,
  MCP-server registration, and permission flow against during implementation.
- **Catalog accuracy / launch-flag drift.** Each known agent's ACP launch flags
  can change across versions; the built-in catalog must be maintainable and a
  `detect` probe should ideally confirm ACP capability, not just binary presence.
  Custom-agent config is the escape hatch when the catalog is stale.
- **MCP-server registration via ACP.** Confirm the chosen reference agent accepts
  per-session MCP server configuration (URL for `mcp-http`, plus the introspection
  server) through the ACP `initialize`/session API.
- **OKF brief size.** Large apps produce large OKF bundles; may need to inject a
  summary + `get_okf_bundle` on demand rather than the full bundle up front.
- **Shell dock interactions** with existing panel layouts (narrow viewports,
  the console's responsive behavior).
