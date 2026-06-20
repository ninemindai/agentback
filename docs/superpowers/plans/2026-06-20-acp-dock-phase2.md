# ACP Agent Dock (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the **agent chat dock** to the console — a right-hand panel that drives a local ACP coding agent, grounded in the live app (Phase 1 introspection MCP + OKF), so a developer can *see and evolve* their app with the agent they already use.

**Architecture:** A new Node-host-only package `@agentback/console-chat`. Server side: a `chatConsoleFeature()` that registers an `@api` bridge controller (agent discovery + doctor, an SSE stream, and POST message/permission/session) and spawns the selected ACP adapter as a subprocess, relaying `session/update` over SSE and `session/request_permission` to the dock. Client side: a dock region added to the console shell, rendering the conversation, tool-activity, the inline permission card, and the composer with a nav-focus chip. The ACP protocol glue is isolated behind one `AcpSession` module, pinned by a spike (Task 1) because the SDK is 0.x and volatile.

**Tech Stack:** TypeScript 6, ESM, `@zed-industries/agent-client-protocol@~0.4.5` (client side) + the `claude-agent-acp` adapter (the agent), Express SSE on the REST host, React for the dock, Zod.

## Global Constraints

- **ESM-only, Node ≥ 22.13.** Relative imports use `.js`. **Node-host-only** — unavailable on `EdgeRestApplication` (spawns a subprocess); the feature no-ops there.
- **Three-line copyright header on every source file.** Never `Copyright IBM Corp.`
- **Lockstep version `0.6.0`**; internal deps `workspace:~`.
- **Transport: SSE (server→client) + POST (client→server).** No WebSocket.
- **Security (load-bearing):** off by default; only renders when `chat.enabled` AND ≥1 agent discovered. All bridge endpoints behind the console `auth` middleware. **Loopback-only** unless each session runs in a disposable sandbox — exposing beyond loopback requires real `auth` + an explicit opt-in, never under `unsafeAllowUnauthenticated`. Permission prompts surface to the user; the only "remember" is a **path+session-scoped** allow, never blanket.
- **ACP is experimental + adapter-isolated.** All protocol calls live in one `AcpSession` module. One pinned reference adapter (`claude-agent-acp`); others are "custom".
- **Design contract:** the spec's "Phase 2 dock design" section + the approved wireframe (`~/.gstack/projects/ninemindai-agentback/designs/agent-dock-20260620/dock-wireframe.html`). Newspaper `console-theme` tokens only.
- **Logging:** `loggers` from `@agentback/common`.

---

### Task 1: ACP spike — pin the SDK client API (research task)

> This is the one non-TDD task. ACP's TS SDK is 0.x and has already deprecated `ClientSideConnection`; the exact client surface MUST be confirmed against the installed version before any bridge code is written. Output is a notes file + a throwaway spike script, not shipped code.

**Files:**
- Create: `packages/console-chat/ACP-NOTES.md` (pinned API reference)
- Create (throwaway): `packages/console-chat/spike/acp-spike.mjs`

- [ ] **Step 1: Install the SDK in a scratch and read its types**

Run: `npm view @zed-industries/agent-client-protocol version` (confirm ~0.4.x), then in the package (created in Task 2) inspect `node_modules/@zed-industries/agent-client-protocol/dist/*.d.ts`.

Answer and record in `ACP-NOTES.md`:
- The current client entrypoint (the non-deprecated replacement for `ClientSideConnection`).
- How to attach to a spawned subprocess's stdio (read/write streams).
- The `initialize` call shape + capability negotiation.
- `session/new` params — confirm it accepts `mcpServers` (URL for HTTP, command for stdio) and which transport the `claude-agent-acp` adapter advertises.
- `session/prompt` + the `session/update` notification stream shape (assistant text deltas, tool calls, plan).
- The `session/request_permission` request shape + how the client answers it.

- [ ] **Step 2: Write a spike that drives the real adapter**

`spike/acp-spike.mjs`: spawn `claude-agent-acp` (document the exact install: `npm i -g @zed-industries/claude-agent-acp` or the correct package name found in Step 1), `initialize`, `session/new` with one MCP server (point at a locally-running `hello-agent-console` `/mcp`), send one prompt, and log every `session/update` + any `request_permission`.

Run: `node packages/console-chat/spike/acp-spike.mjs`
Expected: prints streamed assistant updates; a tool call to the introspection MCP appears; a file-edit prompt triggers `request_permission`.

- [ ] **Step 3: Record the pinned API in `ACP-NOTES.md`**

Write the exact import names, method signatures, and event shapes the bridge (Task 5) will use. Every later task that says "per ACP-NOTES" refers to this file.

- [ ] **Step 4: Commit**

```bash
git add packages/console-chat/ACP-NOTES.md packages/console-chat/spike
git commit -m "spike(console-chat): pin the ACP SDK client API against claude-agent-acp"
```

---

### Task 2: Scaffold `@agentback/console-chat` + the shell dock slot

**Files:**
- Create: `packages/console-chat/{package.json,tsconfig.json,src/index.ts}`
- Modify: `tsconfig.json` (root reference)
- Modify: `packages/console/src/client/types.ts` (add `chat` to `ConsoleClientConfig`)
- Modify: `packages/console/src/client/App.tsx` (dock region)
- Modify: `packages/console-theme/src/index.ts` (dock CSS)
- Test: `packages/console/src/client/__tests__/dock.unit.tsx`

**Interfaces:**
- Produces: `ConsoleClientConfig.chat?: {enabled: boolean; agents: {id: string; name: string}[]; apiBase: string}`; a `<Dock>` region in the shell that renders only when `config.chat?.enabled`.

- [ ] **Step 1: `package.json`** (deps: `@agentback/common`, `@agentback/core`, `@agentback/rest`, `@agentback/console`, `@agentback/console-theme`, `@agentback/introspection`, `@agentback/mcp-http`, `@zed-industries/agent-client-protocol`, `react`, `zod`, `tslib`; devDeps: `@agentback/testing`, `vitest`). Mirror `packages/mcp-http/package.json` shape, `version` `0.6.0`, add `build:client` if it ships TSX (it does — the dock). Model the client build on `packages/console/build-client.mjs`.

- [ ] **Step 2: Extend `ConsoleClientConfig`** in `packages/console/src/client/types.ts`:

```ts
export interface ConsoleClientConfig {
  basePath: string;
  title: string;
  panels: Record<string, {apiBase: string; extra?: Record<string, unknown>}>;
  /** Present only when the chat dock is enabled (≥1 agent discovered). */
  chat?: {
    enabled: boolean;
    apiBase: string; // e.g. /console/chat
    agents: {id: string; name: string}[];
  };
}
```

- [ ] **Step 3: Write the failing test** `packages/console/src/client/__tests__/dock.unit.tsx`:

```tsx
// header…
import {describe, expect, it} from 'vitest';
import {renderToString} from 'react-dom/server';
import {App} from '../App.js';

const base = {basePath: '/console', title: 'c', panels: {}};

describe('console dock slot', () => {
  it('renders no dock when chat is absent', () => {
    const html = renderToString(<App config={base} pages={[]} />);
    expect(html).not.toContain('data-dock');
  });
  it('renders the dock when chat.enabled', () => {
    const cfg = {...base, chat: {enabled: true, apiBase: '/console/chat', agents: [{id: 'cc', name: 'Claude Code'}]}};
    const html = renderToString(<App config={cfg} pages={[]} />);
    expect(html).toContain('data-dock');
  });
});
```

- [ ] **Step 4: Build + run → fails** (`data-dock` not present). `pnpm -F @agentback/console build && pnpm exec vitest run packages/console/dist/client/__tests__/dock.unit.js` (note: client TSX is bundled; if the test can't run post-bundle, place it under the server test glob and import the shared `App` — confirm the console package's existing test setup; if the console has no React test harness yet, add `@testing-library/react` + `jsdom` to devDeps as part of this step).

- [ ] **Step 5: Add the dock region** to `App.tsx`. Wrap the existing `.console` so it becomes `grid-template-columns: 170px 1fr [380px]` when `config.chat?.enabled`. Add a `<Dock config={config.chat} apiBase={config.chat.apiBase} />` element marked `data-dock`, imported lazily from `@agentback/console-chat/console` (so the console package doesn't hard-depend on chat — guard the import behind `config.chat?.enabled`). Below ~1100px (CSS media query) the dock becomes a fixed right-edge tab that toggles an overlay (per the design contract).

- [ ] **Step 6: Add dock CSS** to `console-theme` (the `.dock`, `.dock-head`, `.perm`, `.chip`, `.tool` classes from the approved wireframe — copy the exact token usage).

- [ ] **Step 7: Build + run → passes. Commit.**

```bash
git add packages/console-chat/package.json packages/console-chat/tsconfig.json packages/console-chat/src/index.ts tsconfig.json packages/console/src/client packages/console-theme/src/index.ts
git commit -m "feat(console-chat): scaffold package + shell dock slot (renders when chat.enabled)"
```

---

### Task 3: Navigation-focus context bus (console client)

**Files:**
- Create: `packages/console/src/client/focus.ts`
- Modify: panels that should publish focus (schema-explorer / context-explorer client entries) — minimal: publish on selection.
- Test: `packages/console/src/client/__tests__/focus.unit.ts`

**Interfaces:**
- Produces: `type FocusDescriptor = {kind:'schema-entity'|'binding'|'route'|'tool'; id: string; label?: string}`; `publishFocus(d|null)`, `subscribeFocus(fn): () => void`, `getFocus(): FocusDescriptor|null`. A tiny pub/sub (module-level `Set` of listeners). The descriptor shape matches `@agentback/introspection`'s `get` selector, so the dock can pass it straight through.

- [ ] **Step 1: failing test** — publish a descriptor, assert subscriber receives it; publish `null`, assert cleared; unsubscribe stops delivery.
- [ ] **Step 2: build → fail. Step 3: implement `focus.ts` (no deps). Step 4: build+test → pass.**
- [ ] **Step 5:** wire two panels to `publishFocus` on selection (schema entity click, binding click) and `publishFocus(null)` on deselect/unmount (closes DX gap: chip must never go stale).
- [ ] **Step 6: Commit** `feat(console): navigation-focus bus for the agent dock`.

---

### Task 4: Agent discovery + doctor (server)

**Files:**
- Create: `packages/console-chat/src/agents.ts`
- Test: `packages/console-chat/src/__tests__/agents.unit.ts`

**Interfaces:**
- Produces:
  - `type AgentDescriptor = {id: string; name: string; detect: {bin: string; minVersion?: string}; command: string[]}`
  - `BUILTIN_AGENTS: AgentDescriptor[]` — seeded with the pinned `claude-agent-acp` adapter (exact `command` from ACP-NOTES, Task 1).
  - `discoverAgents(catalog): Promise<{id; name}[]>` — runs each `detect` (PATH probe via `which`/`--version`), returns present agents.
  - `doctor(descriptor): Promise<{status:'ok'|'missing'|'wrong-version'; found?: string; need?: string; fix: string}>` — the F1 affordance; `fix` is the copy-paste install line.

- [ ] **Step 1: failing test** — a descriptor whose `bin` exists resolves `ok`; a bogus `bin` → `missing` with a `fix` string; (mock the probe via an injected `runProbe` fn so the test needs no real binary).
- [ ] **Step 2: build → fail. Step 3: implement** with an injectable `runProbe = (cmd) => execFile…` seam (so tests stub it; matches the framework's injectable-`fetch` pattern). **Step 4: build+test → pass.**
- [ ] **Step 5: Commit** `feat(console-chat): agent catalog, discovery, and doctor (F1)`.

---

### Task 5: The ACP bridge (server) — `AcpSession` + `@api` controller

**Files:**
- Create: `packages/console-chat/src/acp-session.ts` (all ACP protocol glue — per ACP-NOTES)
- Create: `packages/console-chat/src/bridge.controller.ts` (the `@api` endpoints)
- Create: `packages/console-chat/src/feature.ts` (`chatConsoleFeature()`)
- Test: `packages/console-chat/src/__tests__/bridge.unit.ts` (with a fake ACP agent fixture)

**Interfaces:**
- Consumes: `agents.ts`, `AcpSession`, the console `auth` middleware, `loggers`, `AgentError`.
- Produces: `chatConsoleFeature(): ConsoleFeature` (`id:'chat'`, `apiBase:'/console/chat'`, advertises `extra` → the shell's `config.chat`); endpoints:
  - `GET  /console/chat/agents` → discovered agents
  - `POST /console/chat/session` `{agentId}` → `{sessionId}` (spawns adapter, ACP initialize + `session/new` registering the app's `mcp-http` URL + the read-only introspection MCP; injects OKF brief)
  - `GET  /console/chat/stream?sessionId=…` → **SSE** (assistant deltas, tool activity, plan, `permission` requests, lifecycle)
  - `POST /console/chat/message` `{sessionId, text, focus?}` → `session/prompt`
  - `POST /console/chat/permission` `{sessionId, requestId, outcome, scope?}` → answers `request_permission`
  - `DELETE /console/chat/session` `{sessionId}` → stop + kill subprocess
- **Named errors (no catch-all):** `SpawnError`, `AcpHandshakeError`, `PartialTurnError` → mapped to `AgentError` with a clear message. SSE disconnect / agent EOF → tear down session + **kill the subprocess (no orphan)**; sessions hold a short authed lease so a normal reconnect (sleep/proxy/tab-refresh) does NOT destroy the session (the eng/DX finding). Every endpoint carries `sessionId`; the session is bound to the authed principal (no cross-principal access); `call_route`-style mutation does not exist (read-only introspection only).

- [ ] **Step 1: failing test** with a **fake ACP agent** (a stub implementing the ACP-NOTES client interface, no real subprocess): start a session, send a message, assert the SSE stream emits the stubbed assistant update; trigger a stubbed `request_permission` and assert it surfaces on the stream and that `POST /permission` resolves it; assert SSE close kills the (fake) session and a reconnect within the lease window keeps it.
- [ ] **Step 2: build → fail. Step 3: implement `acp-session.ts` (per ACP-NOTES), `bridge.controller.ts` (Express SSE: `res.setHeader('Content-Type','text/event-stream')`, `res.write('data: '+JSON.stringify(ev)+'\\n\\n')`, heartbeat), `feature.ts`. Step 4: build+test → pass.**
- [ ] **Step 5: Commit** `feat(console-chat): ACP bridge — SSE+POST, named errors, leased sessions`.

---

### Task 6: The dock client UI (`@agentback/console-chat/console`)

**Files:**
- Create: `packages/console-chat/src/client/Dock.tsx` (+ `pages`-style export `./console`)
- Create: `packages/console-chat/src/client/sse.ts` (EventSource client + a turn reducer)
- Test: `packages/console-chat/src/client/__tests__/reducer.unit.ts`

**Interfaces:**
- Produces: `Dock` component (consumed by Task 2's shell) implementing the approved wireframe: picker (with doctor states), conversation (assistant deltas + mono tool-activity blocks), the **inline permission card** (rust left border, Approve/Deny ≥44px, **no auto-dismiss**, path+session scope checkbox), composer with the dismissible focus chip (from Task 3's bus), and the six states (no-agent, connecting, doctor/wrong-version, streaming, crashed, rebuild). A pure `turnReducer(state, sseEvent)` so the streaming logic is unit-testable without a DOM.

- [ ] **Step 1: failing test** for `turnReducer`: a sequence of SSE events (assistant delta ×2, tool-call, permission-request, permission-resolved, turn-end) reduces to the expected conversation state; an `error` event yields the crashed state.
- [ ] **Step 2: build → fail. Step 3: implement `sse.ts` + `turnReducer`. Step 4: build+test → pass.**
- [ ] **Step 5: implement `Dock.tsx`** against the wireframe + the reducer; wire the picker to `GET /agents` + `POST /session`, the composer to `POST /message` (attaching `getFocus()`), permission buttons to `POST /permission`. Render all six states.
- [ ] **Step 6: `pnpm typecheck:client`** (the dock TSX must be in the package's `tsconfig.client.json` `include`). Expected: clean.
- [ ] **Step 7: Commit** `feat(console-chat): dock UI — streaming, inline permission card, states`.

---

### Task 7: Grounding wiring + F5 rebuild affordance

**Files:**
- Modify: `packages/console-chat/src/acp-session.ts` (register MCP servers + OKF brief on `session/new`)
- Modify: `packages/console-chat/src/client/Dock.tsx` (rebuild affordance)

- [ ] **Step 1:** on session start, register two MCP servers with the ACP session (per ACP-NOTES): the app's `mcp-http` URL (business tools) and the Phase 1 **introspection** MCP (read-only); inject the OKF brief (summary + on-demand, honoring the Phase 1 TODO if present) as standing context. Test (extend bridge fixture): assert the fake session received both MCP server configs + the brief.
- [ ] **Step 2:** F5 — after the agent reports source edits, the dock shows a "Rebuild & reconnect" affordance; if a `build:watch` restart is detected (the stream drops then the server re-announces), auto-reconnect and re-ground. Test the reconnect path in `turnReducer`.
- [ ] **Step 3: Commit** `feat(console-chat): ground the session (mcp-http + introspection + OKF), F5 rebuild loop`.

---

### Task 8: Docs, example, security model, console wiring

**Files:**
- Create: `packages/console-chat/README.md`
- Modify: `docs/packages.md`, `CLAUDE.md` (capability list), `skills/agentback/SKILL.md` + `references/` page
- Create: `docs/guides/agent-console.md` (the security model: off-by-default, loopback-only, sandbox note, permission scoping)
- Modify: `packages/console/src/index.ts` + `pages.ts` — register `chatConsoleFeature()` into `defaultFeatures()` *only when configured* (gate on `options.chat`), and the dock import
- Modify: `examples/hello-agent-console` — add a `console` entry with `installConsole(app, {chat: {...}})` so the example shows the full see+evolve loop

- [ ] **Step 1:** Write each doc surface (per CLAUDE.md's doc-discipline checklist). The security guide is required given the RCE surface.
- [ ] **Step 2:** Extend `installConsole` options with `chat?: {enabled?; agents?; cwd?; introspection?}`; when present and ≥1 agent discovered, add `chatConsoleFeature()` and inject `config.chat`.
- [ ] **Step 3: Commit** `feat(console-chat): wire into installConsole + docs + example + security guide`.

---

## Final verification

- [ ] `pnpm verify` green.
- [ ] Manual: `pnpm -F hello-agent-console start`, open `/console`, confirm the dock renders, the picker lists the discovered agent (or shows the doctor state), and a prompt streams. Then `/design-review` on the live dock.

## Self-review notes

- **Spec coverage:** dock slot + responsive (Task 2), nav-focus (Task 3), discovery+doctor/F1 (Task 4), bridge SSE+POST + named errors + leased sessions + loopback (Task 5), dock UI + states + inline permission card (Task 6), grounding + F5 (Task 7), docs/security/example (Task 8). The design contract (spec's Phase 2 design section) maps to Tasks 2 + 6.
- **ACP volatility isolated:** all protocol glue is in `acp-session.ts`, pinned by the Task 1 spike; the SDK's deprecation churn touches one file.
- **Security:** loopback-only + off-by-default + leased authed sessions + path/session-scoped permission + read-only introspection (no mutation tools) — the eng/codex/DX findings are folded in.
- **Out of scope (Phase 3):** agent-driven console navigation, multi-session history, the A2A peer surface, file-edit diff rendering beyond the permission card.
- **Open risk:** Task 1 must run against a real `claude-agent-acp` install; if the adapter or SDK API differs from ACP-NOTES, Tasks 5/7 adjust. This is why the spike is first and gated.
