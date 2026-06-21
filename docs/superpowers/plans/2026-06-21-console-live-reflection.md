# Console Live Reflection (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the AgentBack app restarts (the agent or developer edited source and `build:watch` rebuilt), the open dev-console explorer panels auto-refresh to show the new structure.

**Architecture:** A per-process `BOOT_ID` is served over a small `GET {basePath}/live` SSE endpoint in `@agentback/console`. A client `liveBus` opens that stream once; when a reconnect returns a *different* `BOOT_ID`, it publishes a `reload`. The console App bumps a `reloadNonce`; native React explorers (`context-explorer`, `schema-explorer`) refetch in place (selection is derived, so it is preserved automatically), and embedded panels (`rest-explorer`, `mcp-inspector`) remount via React `key`.

**Tech Stack:** TypeScript 6 (ESM, `.js` import extensions), React 18 (`renderToString` for tests), Express 5 SSE, vitest, Node `node:crypto.randomUUID`.

## Global Constraints

- **ESM only:** every relative import ends in `.js` (e.g. `import {x} from './live.js'`), even though the source is `.ts`/`.tsx`.
- **Copyright header:** every new file starts with the 3-line header used by its sibling files:
  ```ts
  // Copyright ninemind.ai 2026. All Rights Reserved.
  // This file is licensed under the MIT License.
  // License text available at https://opensource.org/license/mit/
  ```
- **No reverse dependency:** `context-explorer` / `schema-explorer` must NOT import `@agentback/console`. The console passes data in via props only.
- **No new runtime deps.** SSE only — no WebSocket, no polling.
- **Tests run against built `dist/`:** after editing any `.ts`/`.tsx`, run `pnpm -F @agentback/console build` (and the relevant explorer package build) before `pnpm exec vitest run`. `vitest.config.ts` globs `packages/*/dist/__tests__/**/*.{unit,integration}.js`.
- **React tests use `renderToString`** (`react-dom/server`) — there is no DOM/jsdom env, so `useEffect` does NOT run in tests. Effect-driven behavior is verified by `pnpm verify` + the logic-bearing units (`liveBus`, server handler) which ARE fully unit-tested.
- **Prettier:** single quotes, no bracket spacing (`{x}` not `{ x }`), trailing commas, 80 columns, avoid arrow parens.
- **Branch:** all work on `feat/console-live-reflection` (already created; the design spec commit `973c218` is its first commit).

---

### Task 1: Server — `BOOT_ID` + `/live` SSE handler

**Files:**
- Create: `packages/console/src/live.ts`
- Test: `packages/console/src/__tests__/unit/live-endpoint.unit.ts`

**Interfaces:**
- Produces: `BOOT_ID: string` (module-level, one per process); `liveHandler(req, res): void` (an Express handler that writes the `hello` frame + heartbeats + cleans up on close); `LIVE_HEARTBEAT_MS: number`.
- Consumes: nothing (Task 2 mounts `liveHandler`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/console/src/__tests__/unit/live-endpoint.unit.ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BOOT_ID, liveHandler, LIVE_HEARTBEAT_MS} from '../../live.js';

type FakeRes = {
  setHeader: (k: string, v: string) => void;
  flushHeaders?: () => void;
  write: (chunk: string) => boolean;
  writes: string[];
};
type FakeReq = {on: (ev: string, fn: () => void) => void; _close: () => void};

function fakes(): {req: FakeReq; res: FakeRes} {
  const writes: string[] = [];
  let closeFn = () => {};
  return {
    req: {
      on: (ev, fn) => {
        if (ev === 'close') closeFn = fn;
      },
      _close: () => closeFn(),
    },
    res: {
      setHeader: () => {},
      flushHeaders: () => {},
      write: c => (writes.push(c), true),
      writes,
    },
  };
}

describe('liveHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes a hello frame carrying BOOT_ID on connect', () => {
    const {req, res} = fakes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveHandler(req as any, res as any);
    expect(res.writes[0]).toBe(
      `data: ${JSON.stringify({type: 'hello', bootId: BOOT_ID})}\n\n`,
    );
  });

  it('emits heartbeats on an interval and stops on req close', () => {
    const {req, res} = fakes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveHandler(req as any, res as any);
    vi.advanceTimersByTime(LIVE_HEARTBEAT_MS);
    expect(res.writes).toContain(':hb\n\n');
    const after = res.writes.length;
    req._close();
    vi.advanceTimersByTime(LIVE_HEARTBEAT_MS * 2);
    expect(res.writes.length).toBe(after); // no writes after close
  });

  it('BOOT_ID is a stable non-empty string within the process', () => {
    expect(typeof BOOT_ID).toBe('string');
    expect(BOOT_ID.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/console build`
Expected: FAIL to build — `Cannot find module '../../live.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/console/src/live.ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import type {Request, Response} from 'express';

/**
 * One id per process. A *changed* BOOT_ID seen by the client after an SSE
 * reconnect means the app restarted — the trigger for live reflection.
 */
export const BOOT_ID = randomUUID();

/** Heartbeat cadence; matches the console-chat SSE keepalive. */
export const LIVE_HEARTBEAT_MS = 15000;

/**
 * Express handler for `GET {basePath}/live`. Sends a single `hello` frame with
 * BOOT_ID, then SSE comment heartbeats to keep the connection open. Cleans up
 * on client disconnect. Mounted directly on `server.expressApp` (Task 2) so
 * RestServer.sendResult never ends the stream.
 */
export function liveHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({type: 'hello', bootId: BOOT_ID})}\n\n`);
  const hb = setInterval(() => res.write(':hb\n\n'), LIVE_HEARTBEAT_MS);
  req.on('close', () => clearInterval(hb));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @agentback/console build && pnpm exec vitest run packages/console/dist/__tests__/unit/live-endpoint.unit.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/live.ts packages/console/src/__tests__/unit/live-endpoint.unit.ts
git commit -m "feat(console): BOOT_ID + /live SSE handler"
```

---

### Task 2: Server — mount `/live` in `mountConsole`

**Files:**
- Modify: `packages/console/src/index.ts` (the `mountConsole` function, ~line 150-167)
- Test: `packages/console/src/__tests__/integration/console-live.integration.ts`

**Interfaces:**
- Consumes: `liveHandler`, `BOOT_ID` from Task 1.
- Produces: a live SSE endpoint reachable at `{basePath}/live`, auth-gated by the existing `basePath` guard (`index.ts:117`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/console/src/__tests__/integration/console-live.integration.ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RestApplication} from '@agentback/rest';
import {installConsole} from '../../index.js';

// SSE must NOT be read with supertest (it would hang waiting for stream end).
// Use fetch + AbortController and read only the first chunk.
async function readFirstChunk(url: string): Promise<string> {
  const ac = new AbortController();
  const res = await fetch(url, {signal: ac.signal});
  const reader = res.body!.getReader();
  const {value} = await reader.read();
  ac.abort();
  return new TextDecoder().decode(value);
}

describe('console /live SSE endpoint', () => {
  let app: RestApplication;
  let base: string;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    await installConsole(app, {
      title: 'Live Test',
      unsafeAllowUnauthenticated: true,
    });
    await app.start();
    base = (await app.restServer).url;
  });
  afterEach(async () => app.stop());

  it('serves a hello frame with a bootId at /console/live', async () => {
    const chunk = await readFirstChunk(base + '/console/live');
    expect(chunk).toContain('"type":"hello"');
    expect(chunk).toMatch(/"bootId":"[0-9a-f-]{36}"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/console build && pnpm exec vitest run packages/console/dist/__tests__/integration/console-live.integration.js`
Expected: FAIL — the `fetch` to `/console/live` returns 404 (endpoint not mounted yet), so `readFirstChunk` throws or the chunk lacks `"type":"hello"`.

- [ ] **Step 3: Write minimal implementation**

In `packages/console/src/index.ts`, add the import near the other local imports (after line 14):

```ts
import {liveHandler} from './live.js';
```

In `mountConsole`, immediately after `const app = server.expressApp;` (currently line 151), add:

```ts
  // Live-reflection channel: a per-process boot id over SSE. The client's
  // liveBus refetches the explorer panels when a reconnect returns a NEW boot
  // id (i.e. the app restarted). Mounted on expressApp like the chat stream so
  // RestServer.sendResult never ends it. Under basePath → covered by the auth
  // gate installed in installConsole.
  app.get(basePath + '/live', liveHandler);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @agentback/console build && pnpm exec vitest run packages/console/dist/__tests__/integration/console-live.integration.js`
Expected: PASS (1 test).

- [ ] **Step 5: Run the existing console integration suite (no regressions)**

Run: `pnpm exec vitest run packages/console/dist/__tests__/integration/console.integration.js`
Expected: PASS (all existing tests).

- [ ] **Step 6: Commit**

```bash
git add packages/console/src/index.ts packages/console/src/__tests__/integration/console-live.integration.ts
git commit -m "feat(console): mount /live SSE endpoint in mountConsole"
```

---

### Task 3: Client — `liveBus` (boot-id change → reload)

**Files:**
- Create: `packages/console/src/client/live.ts`
- Test: `packages/console/src/__tests__/unit/live-bus.unit.ts`

**Interfaces:**
- Produces:
  - `subscribeReload(fn: () => void): () => void` — register a reload listener; returns unsubscribe.
  - `subscribeStatus(fn: (connected: boolean) => void): () => void` — connection status (for the "disconnected" dot).
  - `startLiveBus(url: string, options?: {reconnectDelayMs?: number; eventSourceFactory?: EventSourceFactory}): () => void` — open the stream; returns a stop fn. Idempotent guard: a second call while running is a no-op returning the existing stop fn.
  - `type EventSourceFactory = (url: string) => MinimalEventSource` (same shape as `console-chat/src/client/sse.ts`).
- Consumes: nothing (Task 4 calls `startLiveBus` + `subscribeReload` + `subscribeStatus`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/console/src/__tests__/unit/live-bus.unit.ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  startLiveBus,
  subscribeReload,
  subscribeStatus,
  type EventSourceFactory,
} from '../../client/live.js';

// A controllable fake EventSource: tests drive onmessage/onerror by hand.
class FakeES {
  onmessage: ((ev: {data: unknown}) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  hello(bootId: string) {
    this.onmessage?.({data: JSON.stringify({type: 'hello', bootId})});
  }
  drop() {
    this.onerror?.(new Error('drop'));
  }
}

function harness() {
  const created: FakeES[] = [];
  const factory: EventSourceFactory = () => {
    const es = new FakeES();
    created.push(es);
    return es as unknown as ReturnType<EventSourceFactory>;
  };
  return {created, factory};
}

describe('liveBus', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('does NOT fire reload on the first hello (records baseline)', () => {
    const {created, factory} = harness();
    const reloads: number[] = [];
    const un = subscribeReload(() => reloads.push(1));
    stop = startLiveBus('/console/live', {eventSourceFactory: factory});
    created[0].hello('boot-A');
    expect(reloads.length).toBe(0);
    un();
  });

  it('fires reload when a reconnect returns a DIFFERENT boot id', () => {
    vi.useFakeTimers();
    const {created, factory} = harness();
    const reloads: number[] = [];
    const un = subscribeReload(() => reloads.push(1));
    stop = startLiveBus('/console/live', {
      reconnectDelayMs: 10,
      eventSourceFactory: factory,
    });
    created[0].hello('boot-A'); // baseline
    created[0].drop(); // server restarts
    vi.advanceTimersByTime(10); // reconnect → created[1]
    created[1].hello('boot-B'); // new process
    expect(reloads.length).toBe(1);
    un();
  });

  it('does NOT fire reload when a reconnect returns the SAME boot id (blip)', () => {
    vi.useFakeTimers();
    const {created, factory} = harness();
    const reloads: number[] = [];
    const un = subscribeReload(() => reloads.push(1));
    stop = startLiveBus('/console/live', {
      reconnectDelayMs: 10,
      eventSourceFactory: factory,
    });
    created[0].hello('boot-A');
    created[0].drop();
    vi.advanceTimersByTime(10);
    created[1].hello('boot-A'); // same process — transient blip
    expect(reloads.length).toBe(0);
    un();
  });

  it('reports disconnected on drop and connected on (re)hello', () => {
    vi.useFakeTimers();
    const {created, factory} = harness();
    const status: boolean[] = [];
    const un = subscribeStatus(s => status.push(s));
    stop = startLiveBus('/console/live', {
      reconnectDelayMs: 10,
      eventSourceFactory: factory,
    });
    created[0].hello('boot-A'); // connected → true
    created[0].drop(); // → false
    vi.advanceTimersByTime(10);
    created[1].hello('boot-A'); // → true
    expect(status).toEqual([true, false, true]);
    un();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/console build`
Expected: FAIL to build — `Cannot find module '../../client/live.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/console/src/client/live.ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Live-reflection bus. Opens the console `/live` SSE stream and fires a
 * `reload` whenever a reconnect returns a NEW boot id (the app restarted).
 * A reconnect to the SAME boot id is a transient blip and is ignored.
 *
 * Framework-agnostic (no React); the console App subscribes and bumps a
 * `reloadNonce` (see App.tsx). Modeled on console-chat's openSseStream, but
 * kept here to avoid a circular dep (console-chat depends on console).
 */

interface MinimalEventSource {
  onmessage: ((ev: {data: unknown}) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}
export type EventSourceFactory = (url: string) => MinimalEventSource;

type ReloadListener = () => void;
type StatusListener = (connected: boolean) => void;

const _reload = new Set<ReloadListener>();
const _status = new Set<StatusListener>();

export function subscribeReload(fn: ReloadListener): () => void {
  _reload.add(fn);
  return () => _reload.delete(fn);
}
export function subscribeStatus(fn: StatusListener): () => void {
  _status.add(fn);
  return () => _status.delete(fn);
}
function emitReload(): void {
  for (const fn of _reload) fn();
}
function emitStatus(connected: boolean): void {
  for (const fn of _status) fn(connected);
}

let _running = false;
let _stop: (() => void) | undefined;

export function startLiveBus(
  url: string,
  options?: {
    reconnectDelayMs?: number;
    eventSourceFactory?: EventSourceFactory;
  },
): () => void {
  if (_running && _stop) return _stop; // idempotent (StrictMode double-mount)
  _running = true;

  const delay = options?.reconnectDelayMs ?? 2000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const defaultFactory: EventSourceFactory = (u: string) =>
    new ((globalThis as any).EventSource as new (
      url: string,
    ) => MinimalEventSource)(u);
  const makeEs = options?.eventSourceFactory ?? defaultFactory;

  let bootId: string | null = null;
  let cancelled = false;
  let current: MinimalEventSource | null = null;

  function connect(): void {
    if (cancelled) return;
    const es = makeEs(url);
    current = es;
    es.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data as string) as {
          type?: string;
          bootId?: string;
        };
        if (msg.type === 'hello' && typeof msg.bootId === 'string') {
          emitStatus(true);
          if (bootId === null) bootId = msg.bootId; // baseline
          else if (msg.bootId !== bootId) {
            bootId = msg.bootId; // restart
            emitReload();
          }
          // same id → blip → no-op
        }
      } catch {
        // malformed frame — ignore
      }
    };
    es.onerror = () => {
      es.close();
      current = null;
      if (cancelled) return;
      emitStatus(false);
      globalThis.setTimeout(connect, delay); // steady retry, resumes on return
    };
  }

  connect();

  _stop = () => {
    cancelled = true;
    current?.close();
    current = null;
    _running = false;
    _stop = undefined;
  };
  return _stop;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @agentback/console build && pnpm exec vitest run packages/console/dist/__tests__/unit/live-bus.unit.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/client/live.ts packages/console/src/__tests__/unit/live-bus.unit.ts
git commit -m "feat(console): liveBus client — reload on boot-id change"
```

---

### Task 4: Client — wire `reloadNonce` through the console App

**Files:**
- Modify: `packages/console/src/client/types.ts` (`ConsolePanelProps`, `ConsolePage`)
- Modify: `packages/console/src/client/App.tsx` (start bus, hold nonce, Panel strategy, status dot)
- Modify: `packages/console/src/client/pages.tsx` (forward `reloadNonce` to the two native explorers; tag them `liveRefresh: 'prop'`)
- Test: `packages/console/src/__tests__/unit/live-wiring.unit.tsx`

**Interfaces:**
- Consumes: `startLiveBus`, `subscribeReload`, `subscribeStatus` (Task 3); `reloadNonce` prop accepted by `ContextApp`/`SchemaApp` (Tasks 5/6).
- Produces: `ConsolePanelProps.reloadNonce?: number`; `ConsolePage.liveRefresh?: 'prop' | 'remount'`. The Panel passes `reloadNonce` as a prop to `'prop'` pages and folds it into the React `key` of all other pages (remount).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/console/src/__tests__/unit/live-wiring.unit.tsx
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {renderToString} from 'react-dom/server';
import {App} from '../../client/App.js';
import type {ConsolePage} from '../../client/types.js';

const base = {basePath: '/console', title: 'c', panels: {p: {apiBase: '/x'}}};

// A panel that renders whatever reloadNonce it receives, so we can assert the
// shell forwarded it (render-time wiring; effects do not run in renderToString).
const probe: ConsolePage = {
  id: 'p',
  title: 'P',
  icon: '*',
  order: 10,
  route: '/p',
  liveRefresh: 'prop',
  component: ({reloadNonce}: {apiBase: string; reloadNonce?: number}) => (
    <span data-nonce={String(reloadNonce ?? 'none')}>panel</span>
  ),
};

describe('console live-reflection wiring', () => {
  it('forwards reloadNonce (initial 0) to a liveRefresh:prop panel', () => {
    const html = renderToString(<App config={base} pages={[probe]} />);
    expect(html).toContain('data-nonce="0"');
  });

  it('renders the panel content', () => {
    const html = renderToString(<App config={base} pages={[probe]} />);
    expect(html).toContain('panel');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/console build`
Expected: FAIL to build — `ConsolePage` has no `liveRefresh`, and the probe component types `reloadNonce` which `ConsolePanelProps` does not declare; also `App` does not yet pass `reloadNonce`.

- [ ] **Step 3a: Extend the types**

In `packages/console/src/client/types.ts`, add to `ConsolePanelProps` (after `extra?`):

```ts
  /** Bumped by the shell when the app restarts; panels refetch on change. */
  reloadNonce?: number;
```

And add to `ConsolePage` (after `component`):

```ts
  /**
   * How this panel reacts to a live-reflection reload. `'prop'` panels accept
   * `reloadNonce` and refetch in place (selection preserved). Any other value
   * (default) is remounted via React `key` on reload. Default: `'remount'`.
   */
  liveRefresh?: 'prop' | 'remount';
```

- [ ] **Step 3b: Wire the App**

In `packages/console/src/client/App.tsx`, add imports (after the existing imports):

```ts
import {startLiveBus, subscribeReload, subscribeStatus} from './live.js';
```

Inside `App(...)`, after `const onToggleDock = ...` (line 55), add state + the bus effect:

```ts
  const [reloadNonce, setReloadNonce] = useState(0);
  const [live, setLive] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stop = startLiveBus(config.basePath + '/live');
    const offReload = subscribeReload(() => setReloadNonce(n => n + 1));
    const offStatus = subscribeStatus(setLive);
    return () => {
      offReload();
      offStatus();
      stop();
    };
  }, [config.basePath]);
```

Change the `<Panel .../>` call (line 78) to pass the nonce:

```tsx
          <Panel page={active} config={config} reloadNonce={reloadNonce} />
```

(Drop the `key={active.id}` on this element — the Panel now owns keying. See Step 3c.)

Add a status dot inside `<aside className="sidebar">`, right after `<div className="brand">…</div>` (line 60):

```tsx
        {!live && (
          <div className="live-offline" title="Disconnected from the app">
            ● offline
          </div>
        )}
```

Append to the `CONSOLE_CSS`-equivalent — the console CSS lives in `index.ts`; add the rule there in Step 3d.

- [ ] **Step 3c: Update the `Panel` component**

Replace the `Panel` function (lines 119-129) with:

```tsx
function Panel({
  page,
  config,
  reloadNonce,
}: {
  page: ConsolePage;
  config: ConsoleClientConfig;
  reloadNonce: number;
}) {
  const panel = config.panels[page.id] ?? {apiBase: ''};
  const Component = page.component;
  // 'prop' panels refetch in place (selection preserved); all others remount
  // via key so a reload gives them a fresh fetch.
  if (page.liveRefresh === 'prop') {
    return (
      <Component
        apiBase={panel.apiBase}
        extra={panel.extra}
        reloadNonce={reloadNonce}
      />
    );
  }
  return (
    <Component
      key={page.id + ':' + reloadNonce}
      apiBase={panel.apiBase}
      extra={panel.extra}
    />
  );
}
```

Add `ConsolePage` to the type import at the top of `App.tsx` if not already imported (it is: line 7 imports from `./types.js` — ensure `ConsolePage` is in that import list; it already is via `ConsolePage`).

- [ ] **Step 3d: Add the offline-dot CSS**

In `packages/console/src/index.ts`, inside the `CONSOLE_CSS` template (after the `.panel` rule, ~line 229), add:

```css
.live-offline { font-size:11px; color:var(--accent); margin:0 0 .75rem; padding:0 .4rem; letter-spacing:.02em; }
```

- [ ] **Step 3e: Forward the nonce in `pages.tsx`**

In `packages/console/src/client/pages.tsx`, update the context page object: add `liveRefresh: 'prop',` after `route: '/context',` and change its component to accept + forward the nonce:

```tsx
    liveRefresh: 'prop',
    component: ({apiBase, reloadNonce}: {apiBase: string; reloadNonce?: number}) => (
      <ContextApp
        apiBase={apiBase}
        title="Context Explorer"
        reloadNonce={reloadNonce}
        onFocusChange={key =>
          publishFocus(key ? {kind: 'binding', id: key} : null)
        }
      />
    ),
```

Do the same for the schema page object: add `liveRefresh: 'prop',` after `route: '/schema',` and:

```tsx
    liveRefresh: 'prop',
    component: ({apiBase, reloadNonce}: {apiBase: string; reloadNonce?: number}) => (
      <SchemaApp
        apiBase={apiBase}
        title="Schema Explorer"
        reloadNonce={reloadNonce}
        onFocusChange={(id, label) =>
          publishFocus(id ? {kind: 'schema-entity', id, label} : null)
        }
      />
    ),
```

(`ContextApp`/`SchemaApp` gain the `reloadNonce` prop in Tasks 5/6. Until those land this file will type-error on `reloadNonce`; that is expected — Tasks 5/6 close it. Run the build at the END of Task 6, not after Task 4's edit, OR temporarily cast. To keep each task independently green, implement Tasks 5 and 6 BEFORE re-running the full console build. The `live-wiring.unit.tsx` test uses its own probe component and does not depend on the explorers, so it passes once types.ts + App.tsx compile.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @agentback/console build && pnpm exec vitest run packages/console/dist/__tests__/unit/live-wiring.unit.js`
Expected: PASS (2 tests). If the build fails only on `pages.tsx` `reloadNonce`, proceed to Tasks 5/6 then return; the unit test target itself does not import `pages.tsx`.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/client/types.ts packages/console/src/client/App.tsx packages/console/src/client/pages.tsx packages/console/src/index.ts packages/console/src/__tests__/unit/live-wiring.unit.tsx
git commit -m "feat(console): wire reloadNonce through the shell (prop vs remount + offline dot)"
```

---

### Task 5: `context-explorer` — refetch on `reloadNonce`

**Files:**
- Modify: `packages/context-explorer/src/client/App.tsx`
- Test: `packages/context-explorer/src/__tests__/unit/app-reload-prop.unit.tsx`

**Interfaces:**
- Consumes: `reloadNonce?: number` prop (from console `pages.tsx`, Task 4).
- Produces: `App` accepts `reloadNonce`; on change (>0) it re-runs `api.fetchModel()`. Selection (`selectedKey`) is React state and `selected` is derived (`bindings.find`), so it is preserved automatically and resolves to `null` if the binding vanished.

- [ ] **Step 1: Write the failing test**

```tsx
// packages/context-explorer/src/__tests__/unit/app-reload-prop.unit.tsx
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {renderToString} from 'react-dom/server';
import {App} from '../../client/App';

// renderToString does not run effects, so we assert the contract that matters
// at the type/render boundary: App accepts an optional reloadNonce prop and
// still renders its header without crashing.
describe('context-explorer App reloadNonce prop', () => {
  it('renders with a reloadNonce prop present', () => {
    const html = renderToString(<App apiBase="/x" reloadNonce={3} />);
    expect(html).toContain('Context Explorer');
  });

  it('renders without a reloadNonce prop (standalone)', () => {
    const html = renderToString(<App apiBase="/x" />);
    expect(html).toContain('Context Explorer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/context-explorer build`
Expected: FAIL to build — `App` does not accept a `reloadNonce` prop (`Property 'reloadNonce' does not exist`).

- [ ] **Step 3: Implement**

In `packages/context-explorer/src/client/App.tsx`:

Add `useCallback` to the React import (line 5):

```ts
import {useCallback, useEffect, useMemo, useState} from 'react';
```

Add `reloadNonce` to the props (the `App({...}: {...})` signature, lines 33-42):

```tsx
export function App({
  apiBase,
  title = 'Context Explorer',
  reloadNonce = 0,
  onFocusChange,
}: {
  apiBase: string;
  title?: string;
  /** Bumped by the console shell when the app restarts; refetch on change. */
  reloadNonce?: number;
  /** Called with the selected binding key, or null when nothing is selected. */
  onFocusChange?: (key: string | null) => void;
}) {
```

Add a non-fatal reload-error flag near the other state (after line 50):

```ts
  const [reloadError, setReloadError] = useState(false);
```

Replace the mount fetch effect (lines 60-62) with a reusable loader + two effects:

```tsx
  const load = useCallback(
    () =>
      api.fetchModel().then(
        m => {
          setModel(m);
          setReloadError(false);
        },
        e => setError(String(e)),
      ),
    [api],
  );

  // Initial load (and on apiBase change).
  useEffect(() => {
    load();
  }, [load]);

  // Live reflection: refetch on restart. Keep stale data on failure (the app
  // may be mid-restart) — surface a non-fatal notice instead of blanking.
  useEffect(() => {
    if (reloadNonce === 0) return;
    api.fetchModel().then(setModel, () => setReloadError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);
```

Add a non-fatal notice in the header — inside `<header>`, after the `count` span (line 157), add:

```tsx
        {reloadError && (
          <span className="count" title="Could not refresh after restart">
            ⚠ stale
          </span>
        )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @agentback/context-explorer build && pnpm exec vitest run packages/context-explorer/dist/__tests__/unit/app-reload-prop.unit.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/context-explorer/src/client/App.tsx packages/context-explorer/src/__tests__/unit/app-reload-prop.unit.tsx
git commit -m "feat(context-explorer): refetch on reloadNonce (preserve selection)"
```

---

### Task 6: `schema-explorer` — refetch on `reloadNonce`

**Files:**
- Modify: `packages/schema-explorer/src/client/App.tsx`
- Test: `packages/schema-explorer/src/__tests__/unit/app-reload-prop.unit.tsx`

**Interfaces:**
- Consumes: `reloadNonce?: number` prop (from console `pages.tsx`, Task 4).
- Produces: `App` accepts `reloadNonce`; on change (>0) re-runs `api.fetchSchemas()`. Selection (`selectedId`) preserved automatically (`selected` is `nodes.find`).

- [ ] **Step 1: Write the failing test**

```tsx
// packages/schema-explorer/src/__tests__/unit/app-reload-prop.unit.tsx
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {renderToString} from 'react-dom/server';
import {App} from '../../client/App';

describe('schema-explorer App reloadNonce prop', () => {
  it('renders with a reloadNonce prop present', () => {
    const html = renderToString(<App apiBase="/x" reloadNonce={2} />);
    expect(html).toContain('Schema Explorer');
  });

  it('renders without a reloadNonce prop (standalone)', () => {
    const html = renderToString(<App apiBase="/x" />);
    expect(html).toContain('Schema Explorer');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @agentback/schema-explorer build`
Expected: FAIL to build — `App` does not accept a `reloadNonce` prop.

- [ ] **Step 3: Implement**

In `packages/schema-explorer/src/client/App.tsx`:

Add `useCallback` to the React import (line 5):

```ts
import {useCallback, useEffect, useMemo, useState} from 'react';
```

Add `reloadNonce` to the props (signature lines 24-33):

```tsx
export function App({
  apiBase,
  title = 'Schema Explorer',
  reloadNonce = 0,
  onFocusChange,
}: {
  apiBase: string;
  title?: string;
  /** Bumped by the console shell when the app restarts; refetch on change. */
  reloadNonce?: number;
  /** Called with the selected schema id, or null when nothing is selected. */
  onFocusChange?: (id: string | null, label?: string) => void;
}) {
```

Add a non-fatal reload-error flag near the other state (after line 39):

```ts
  const [reloadError, setReloadError] = useState(false);
```

Replace the mount fetch effect (lines 41-43) with:

```tsx
  const load = useCallback(
    () =>
      api.fetchSchemas().then(
        n => {
          setNodes(n);
          setReloadError(false);
        },
        e => setError(String(e)),
      ),
    [api],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Live reflection: refetch on restart; keep stale data on failure.
  useEffect(() => {
    if (reloadNonce === 0) return;
    api.fetchSchemas().then(setNodes, () => setReloadError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);
```

Add a non-fatal notice in the header — inside `<header>`, after the `count` span (line 88):

```tsx
          {reloadError && (
            <span className="count" title="Could not refresh after restart">
              ⚠ stale
            </span>
          )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @agentback/schema-explorer build && pnpm exec vitest run packages/schema-explorer/dist/__tests__/unit/app-reload-prop.unit.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Rebuild the console (now `pages.tsx` types resolve) and run its suite**

Run: `pnpm -F @agentback/console build && pnpm exec vitest run packages/console/dist/__tests__`
Expected: PASS (all console unit + integration tests, including `live-wiring`, `live-bus`, `live-endpoint`, `console-live`).

- [ ] **Step 6: Commit**

```bash
git add packages/schema-explorer/src/client/App.tsx packages/schema-explorer/src/__tests__/unit/app-reload-prop.unit.tsx
git commit -m "feat(schema-explorer): refetch on reloadNonce (preserve selection)"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `packages/console/README.md`
- Modify: `docs/guides/` console guide (the file that documents the console; if none exists for live reflection, add a short "Live reflection" section to the existing console guide referenced from `docs/README.md`).

**Interfaces:** none (documentation + CI mirror).

- [ ] **Step 1: Document in the console README**

Add a `## Live reflection` section to `packages/console/README.md` describing: when the app restarts (agent/dev edits source + `build:watch`), open explorer panels auto-refresh; powered by a per-process boot id over `GET {basePath}/live` SSE; native explorers refetch in place (selection preserved), embedded panels remount; the offline dot; no configuration required (on whenever the console is mounted). Note it is Node-host-only and SSE-based.

```markdown
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
```

- [ ] **Step 2: Document in the console guide under `docs/`**

Find the console guide (`grep -rl "installConsole" docs/`) and add the same "Live reflection" section, cross-linking the Phase 2 evolve→see loop. If `docs/README.md` has a console row, no new link is needed; otherwise add one.

- [ ] **Step 3: Commit docs**

```bash
git add packages/console/README.md docs/
git commit -m "docs(console): document live reflection"
```

- [ ] **Step 4: Full CI-mirror verification**

Run: `pnpm verify`
Expected: build + typecheck:client + test + validate-templates all green. (This is the authoritative gate for the React glue, since `renderToString` tests do not run effects.)

- [ ] **Step 5: Manual smoke (optional but recommended)**

In `examples/hello-agent-console` (or any app that mounts the console): start it, open `/console`, select a binding in Context Explorer, edit a source file so the app rebuilds/restarts, and confirm the panel refreshes with the selection preserved and the offline dot flashes during the restart.

---

## Self-Review

**Spec coverage:**
- Structure-on-rebuild scope → Tasks 1-6 (boot id restart detection, no domain-state view). ✓
- Independent console channel (not chat-coupled) → Task 1/2 `/console/live`, started by the App regardless of chat. ✓
- Auto-refresh, preserve state → Tasks 5/6 (derived selection preserved; refetch in place). ✓
- SSE boot-id transport (Approach A) → Tasks 1-3. ✓
- Blip vs restart → Task 3 (`live-bus.unit` same-id vs changed-id). ✓
- Server still down → Task 3 steady-retry + Task 4 offline dot. ✓
- Refetch fails mid-restart → Tasks 5/6 `reloadError` keeps stale data + "⚠ stale". ✓
- Selection reconciliation → automatic via derived `selected`; covered by design (no extra code). ✓
- Embedded panels remount → Task 4 Panel `key`. ✓
- Tests: server handler unit (T1), integration frame shape (T2), liveBus unit (T3), explorer render (T5/T6). ✓
- Docs → Task 7. ✓
- Out of scope (domain state, edge, WebSocket, explorer read-API changes) → none added. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `reloadNonce: number` (App state, prop) consistent across types.ts, App.tsx, pages.tsx, both explorers. `liveRefresh: 'prop' | 'remount'` consistent. `startLiveBus`/`subscribeReload`/`subscribeStatus`/`EventSourceFactory` names match between Task 3 (def) and Task 4 (use). `liveHandler`/`BOOT_ID`/`LIVE_HEARTBEAT_MS` match between Task 1 (def) and Task 2 (use). ✓

**Known sequencing note:** Task 4's `pages.tsx` edit references `reloadNonce` on `ContextApp`/`SchemaApp`, which land in Tasks 5/6. The full console build goes green at Task 6 Step 5; Task 4's own unit test target does not import `pages.tsx`, so it passes independently. This is called out inline in Task 4 Step 3e.
