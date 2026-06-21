# Console live reflection (Phase 3) — design

**Date:** 2026-06-21
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** `@agentback/console` (+ a small `refetch()` seam in `context-explorer` / `schema-explorer`)

## Motivation

Phase 1 (`@agentback/introspection`) and Phase 2 (`@agentback/console-chat` ACP dock)
shipped. The Phase 2 design listed **live reflection** as a Tier-2 follow-up:
*"when the agent mutates state via a tool, the open explorer panels refresh so the
human sees the change immediately."*

That original note conflated two different things. The dev-console explorers
(`context-explorer`, `schema-explorer`, plus the embedded `rest-explorer` and
`mcp-inspector`) reflect **app structure** — DI bindings, Zod schemas, routes,
tables — which is built once at `app.start()` and only changes when **source is
edited and the app rebuilds/restarts**. The `actors`/`messaging` event
subscriptions carry **domain/business state**, which no explorer renders today.

**Decision:** Phase 3 mirrors **structure on rebuild**, not domain state. When the
agent (or the human) edits source and the app restarts, the open console panels
auto-refresh to show the new structure. This is the dev-console realization of the
"watch your app evolve" loop, and it reuses the restart detection the dock already
performs.

Domain/business-state reflection (a live actor/EventBus view) remains a separate,
larger future feature and is explicitly **out of scope** here.

## Decisions (from brainstorm)

1. **Reflect structure on rebuild** — not domain state, not both.
2. **Independent console channel** — restart detection is console-wide, not coupled
   to an open chat session. Live reflection works whenever the console is open.
3. **Auto-refresh, preserve state** — on restart the native explorers refetch
   immediately and restore the current selection/filters where the entity still
   exists, with a subtle "updated" indicator. Not a manual "Refresh" banner, not a
   destructive reset.
4. **Transport: SSE boot-id channel** (Approach A) — reuse the proven SSE handler +
   focus-bus patterns; event-driven (no polling); no new deps; WebSocket is out of
   scope per the Phase 2 design.

## Architecture

Everything new lives in `@agentback/console`, except an optional `refetch()` seam
added to each native explorer. Layering is unchanged: `console` depends on the
explorers; the explorers never depend on `console`.

### Components

1. **`bootId` (server).** A single `crypto.randomUUID()` minted at module load in
   the console feature. It is the process identity: a *new* value after a reconnect
   means the app restarted.

2. **`GET /console/live` SSE endpoint** (`@agentback/console`). Mounted **directly
   on `server.expressApp`** (not via a `@get` decorator), the same workaround
   `console-chat` uses (`packages/console-chat/src/feature.ts:114`) so
   `RestServer.sendResult` does not `res.end()` the stream. On connect it writes a
   `data: {"type":"hello","bootId":…}` frame, then a 15s heartbeat; it cleans up on
   `req.close`. Mirrors `handleSseRequest`
   (`packages/console-chat/src/bridge.controller.ts:549`).

3. **`liveBus` client module** (`packages/console/src/client/live.ts`) — a small
   pub/sub modeled on the existing `packages/console/src/client/focus.ts`. It opens
   the `/console/live` EventSource once when the console mounts, records the first
   `bootId`, and on reconnect compares: a reload is published **only when the
   bootId changes**. A transient network blip reconnects to the *same* bootId and
   therefore does **not** trigger a refresh. Self-contained EventSource-with-
   reconnect logic (~30 lines, same shape as `packages/console-chat/src/client/sse.ts`,
   with the same fake-EventSource seam for tests).

4. **Per-panel refresh — two strategies:**
   - **Native React explorers** (`context-explorer`, `schema-explorer`) receive an
     optional **`reloadNonce` prop** from the console `Panel` wrapper
     (`packages/console/src/client/App.tsx:119`), bumped on each reload. Each
     explorer App watches it (`useEffect(…, [reloadNonce]) → api.refetch()`),
     **preserving selection/filters** and clearing the selection only if that
     entity no longer exists, with a subtle "updated" header indicator. The prop is
     optional, so standalone explorer mounts are unaffected and live reflection is
     simply absent there.
   - **Embedded panels** (`rest-explorer` Swagger UI, `mcp-inspector`) have no
     selection worth preserving — the nonce is folded into their React **`key`** so
     a reload **remounts** them (fresh `/openapi.json` / tool list). The key is
     per-panel, so remounting an embedded panel never resets a native explorer's
     selection.

### Data flow

```
agent/human edits source
  → build:watch recompiles → process manager restarts the app (same port)
  → /console/live SSE socket drops
  → liveBus reconnects → receives a NEW bootId
  → liveBus publishes 'reload' → console App bumps reloadNonce
  → native explorers refetch in place (preserve selection)
  · embedded panels remount (fresh fetch)
```

The dropped socket is the restart trigger; the bootId comparison distinguishes a
real restart from a transient reconnect.

## Error handling

- **Blip vs restart.** Reconnect to the same bootId → no refetch. Only a changed
  bootId triggers reload. This is the core reason for a bootId rather than treating
  any socket drop as a refresh.
- **Server still down (reconnect exhausted).** Bounded retries with backoff (same
  shape as `sse.ts`'s `maxReconnects` / `reconnectDelayMs`). When exhausted, the
  console shows a quiet "disconnected" indicator and the bus keeps a slow retry, so
  it resumes when the app returns. Never hammer the endpoint.
- **Refetch fails mid-restart (502 / partial boot).** The panel **keeps its stale
  data** plus a small "couldn't refresh — retry" affordance; it never blanks. A
  later reload (or manual retry) recovers. A failed refetch must not destroy what
  the user is viewing.
- **Selection reconciliation.** After refetch, if the previously-selected
  binding/schema no longer exists (the edit removed it), clear the selection
  gracefully instead of leaving a broken detail view.

## Testing

- **Server** — unit-test the `/console/live` handler: emits `hello`+bootId on
  connect, writes heartbeats, cleans up on `req.close`; bootId stable within a
  process. Mirror the existing console-chat SSE tests.
- **`liveBus` client** — pure unit test via the fake-EventSource seam: feed a
  bootId sequence and assert `reload` fires **only on change**, plus the
  reconnect/backoff behavior.
- **Explorer refetch + preservation** — component test: mount with data, bump
  `reloadNonce`, assert `refetch()` ran, selection preserved when the entity
  persists and cleared when it is gone.
- **Integration** — `createTestApp` with the console feature; `GET /console/live`;
  assert the SSE frame shape (`hello` + bootId).

## File-level change map

New:
- `packages/console/src/live.ts` (or in `feature.ts`) — `bootId` + `/console/live`
  SSE handler, mounted on `server.expressApp`.
- `packages/console/src/client/live.ts` — `liveBus` (open stream, bootId compare,
  `subscribeReload`).
- Tests: console SSE unit + integration, `liveBus` client unit, explorer refetch
  component tests.

Modified:
- `packages/console/src/feature.ts` — mount the SSE handler (alongside the existing
  console wiring).
- `packages/console/src/client/App.tsx` — start the `liveBus` on mount; maintain
  `reloadNonce`; pass it to native panels as a prop and into embedded panels' `key`.
- `packages/context-explorer/src/client/{App.tsx,api.ts}` — add `refetch()` +
  optional `reloadNonce` prop + selection reconciliation + "updated" indicator.
- `packages/schema-explorer/src/client/{App.tsx,api.ts}` — same.
- Docs: `packages/console/README.md` + the console guide under `docs/`.

## Out of scope

- **Domain/business-state reflection** — a live actor/EventBus view streaming state
  changes on tool calls. No explorer renders this today; it is a separate, larger
  future feature.
- **Edge-host support** — the console is Node-host-only by design.
- **WebSocket surface** — SSE only (consistent with the Phase 2 design boundary).
- **Changes to the explorers' read APIs** beyond adding `refetch()`.
- **Forcing a rebuild** — Phase 3 detects and reflects a restart; it does not run or
  manage the build/watch/restart toolchain (that is the developer's `build:watch` +
  process manager, as established in the Phase 2 F5 note).

## References

- Phase 2 design: `docs/superpowers/specs/2026-06-19-console-chat-acp-design.md`
  (Tier-2 "live reflection (agent-as-acting-peer)"; F5 honest evolve→see loop).
- Phase 2 plan: `docs/superpowers/plans/2026-06-20-acp-dock-phase2.md`
  ("Out of scope (Phase 3)").
- SSE handler pattern: `packages/console-chat/src/bridge.controller.ts:549`
  (`handleSseRequest`), mounted in `packages/console-chat/src/feature.ts:114`.
- SSE client + reconnect/early-drop pattern (fake-EventSource seam):
  `packages/console-chat/src/client/sse.ts`.
- Client pub/sub pattern: `packages/console/src/client/focus.ts`.
- Explorer one-shot fetch (no refresh today): `packages/context-explorer/src/client/App.tsx:60`,
  `packages/schema-explorer/src/client/App.tsx:41`.
