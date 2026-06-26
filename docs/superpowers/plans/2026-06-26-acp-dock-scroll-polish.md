# ACP Dock Scroll Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the console-chat agent dock's hand-rolled auto-scroll with the headless `@shadcn/react` `MessageScroller` (stick-to-bottom-unless-scrolled-up + a "jump to latest" button), and add ported `scroll-fade` / `shimmer` CSS utilities to `console-theme`.

**Architecture:** The dock's scroll container (`.stream` div + a `scrollTop = scrollHeight` effect) is rebuilt as a `MessageScroller.Provider → Root → Viewport → Content → Item` tree from `@shadcn/react/message-scroller`. The library owns scroll position; the manual ref/effect are deleted. Two plain-CSS utilities (`scroll-fade`, `shimmer`) are ported from shadcn's Tailwind utilities into `@agentback/console-theme`'s `THEME_CSS` string — no Tailwind/Radix enters the repo.

**Tech Stack:** React 19, `@shadcn/react@~0.1.0` (headless, zero runtime deps), esbuild client bundle, `@agentback/console-theme` (CSS-as-string), pnpm 11 workspace, vitest (server `dist/` only — client TSX is typecheck-only).

## Global Constraints

- Node 22.13+, TypeScript 6.0, ESM-only, `.js` extensions on relative imports.
- New source files carry the three-line MIT header (`// Copyright ninemind.ai 2026. All Rights Reserved.` …). This plan modifies existing files only — preserve their headers.
- `@shadcn/react` peer dep is `react >=19`; console-chat is on `react ~19.2.7` ✓.
- `@shadcn/react` bundles into `dist/client/main.js` — it must NOT be added to the `external` array in `build-client.mjs` (only `react`/`react-dom`/`react/jsx-runtime` stay external).
- The client TSX (`src/client/**`) is excluded from vitest; `pnpm typecheck:client` is its only type gate. There is no unit-test seam for DOM scroll behavior — verification is build + typecheck:client + manual.
- Prettier: single quotes, no bracket spacing (`{foo}`), trailing commas, 80 col, avoid arrow parens.
- pnpm 11 supply-chain age policy: if `pnpm install` fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` on `@shadcn/react`, pin one patch older and note the reason in the commit.

---

### Task 1: Add `@shadcn/react` dependency + port `scroll-fade`/`shimmer` and dock-scroll CSS into `console-theme`

**Files:**
- Modify: `packages/console-chat/package.json` (add dependency)
- Modify: `packages/console-theme/src/index.ts` (add CSS to `THEME_CSS` string; line refs below)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: CSS classes other tasks rely on — `.shimmer`, `.scroll-fade`, `.dock-streaming`, `.dock-stream-root`, `.dock-stream-content`, `.dock-jump`; and a modified `.stream` rule (layout moved to `.dock-stream-content`).

- [ ] **Step 1: Add the dependency to console-chat**

In `packages/console-chat/package.json`, add `@shadcn/react` to `dependencies` (keep alphabetical/existing order, just after the `@agentback/*` deps and before `react`):

```jsonc
"@shadcn/react": "~0.1.0",
```

- [ ] **Step 2: Install**

Run: `pnpm install`
Expected: completes, `pnpm-lock.yaml` updated with `@shadcn/react`. If it fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, change the range to the next-older published patch (`npm view @shadcn/react versions`) and rerun.

- [ ] **Step 3: Add the shimmer keyframe + utility to `THEME_CSS`**

In `packages/console-theme/src/index.ts`, find line 41:

```
@keyframes rise { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
```

Insert immediately AFTER it:

```css
@keyframes shimmer { to { background-position:-200% center; } }
.shimmer {
  background:linear-gradient(100deg, var(--muted) 35%, var(--ink) 50%, var(--muted) 65%);
  background-size:200% auto; -webkit-background-clip:text; background-clip:text;
  color:transparent; animation:shimmer 1.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .shimmer { animation:none; background:none; color:var(--muted); -webkit-text-fill-color:currentColor; }
}
@supports (animation-timeline: scroll()) {
  .scroll-fade {
    --fade:18px;
    -webkit-mask-image:linear-gradient(to bottom, transparent 0, #000 var(--fade), #000 calc(100% - var(--fade)), transparent 100%);
    mask-image:linear-gradient(to bottom, transparent 0, #000 var(--fade), #000 calc(100% - var(--fade)), transparent 100%);
  }
}
```

(`.scroll-fade` is gated on `@supports (animation-timeline: scroll())` so it is a no-op — content fully visible — where unsupported, matching the spec's "degrade to no fade" requirement.)

- [ ] **Step 4: Replace the `.stream` rule and add the scroll-container split classes**

In the same file, find line 85:

```
.stream { flex:1; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:14px; }
```

Replace that single line with:

```css
.stream { flex:1; min-height:0; overflow:auto; }
.dock-stream-root { flex:1; min-height:0; position:relative; display:flex; flex-direction:column; }
.dock-stream-content { display:flex; flex-direction:column; gap:14px; padding:14px; }
.dock-streaming { display:flex; align-items:center; gap:8px; padding-left:4px; }
.dock-jump {
  position:absolute; left:50%; bottom:12px; transform:translateX(-50%);
  background:var(--card); border:1px solid var(--line-2); color:var(--ink);
  font:inherit; font-size:11.5px; padding:.3rem .75rem; border-radius:999px;
  cursor:pointer; box-shadow:0 2px 8px rgba(34,29,22,.16); z-index:2;
}
.dock-jump:hover { border-color:var(--accent); color:var(--accent); }
```

(The padding/gap/flex that were on `.stream` move to `.dock-stream-content`, which becomes the `MessageScroller.Content` element in Task 2. `.dock-stream-root` is `position:relative` so the absolutely-positioned `.dock-jump` anchors to it.)

- [ ] **Step 5: Build console-theme and verify the classes are present**

Run: `pnpm -F @agentback/console-theme build && grep -c "dock-jump\|scroll-fade\|\.shimmer\|dock-stream-root\|dock-stream-content\|dock-streaming" packages/console-theme/dist/index.js`
Expected: build succeeds; grep prints `6` (all six identifiers present in the emitted bundle).

- [ ] **Step 6: Commit**

```bash
git add packages/console-chat/package.json packages/console-theme/src/index.ts pnpm-lock.yaml
git commit -m "feat(console-theme): add scroll-fade/shimmer utilities + dock scroll-container CSS

Ports shadcn's scroll-fade (pure-CSS scroll-driven edge fade) and shimmer
(live-status text) utilities, and splits the dock stream container styling
for the MessageScroller adoption in console-chat. Adds @shadcn/react dep.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Rewire `Dock.tsx` stream container to `MessageScroller` + shimmer status text

**Files:**
- Modify: `packages/console-chat/src/client/Dock.tsx`
  - Imports (line 23-43 region)
  - Remove `streamRef` (line 352) and the auto-scroll `useEffect` (lines 366-372)
  - Replace the stream `<div className="stream" ref={streamRef}>…</div>` block (lines 612-748)
  - Add `shimmer` class to the `connecting` status text (lines 633-645)

**Interfaces:**
- Consumes: from Task 1 — CSS classes `.stream`, `.scroll-fade`, `.dock-stream-root`, `.dock-stream-content`, `.dock-streaming`, `.dock-jump`, `.shimmer`. From `@shadcn/react/message-scroller` — `MessageScroller` (compound: `.Provider`, `.Root`, `.Viewport`, `.Content`, `.Item`, `.Button`).
- Produces: nothing downstream (Task 3 is docs only).

- [ ] **Step 1: Add the MessageScroller import**

In `packages/console-chat/src/client/Dock.tsx`, after the existing `import {Markdown} from './markdown.js';` (line 43), add:

```ts
import {MessageScroller} from '@shadcn/react/message-scroller';
```

- [ ] **Step 2: Remove the now-unused `useRef` import**

In the `react` import block (lines 23-29), remove `useRef,` (it is used only by `streamRef`, which is being deleted). The block becomes:

```ts
import {
  useCallback,
  useEffect,
  useReducer,
  useState,
} from 'react';
```

- [ ] **Step 3: Delete the `streamRef` declaration**

Remove line 352:

```ts
  const streamRef = useRef<HTMLDivElement | null>(null);
```

- [ ] **Step 4: Delete the manual auto-scroll effect**

Remove the entire block at lines 366-372:

```ts
  // ── Auto-scroll to bottom ─────────────────────────────────────────────────
  useEffect(() => {
    const el = streamRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [conv.messages.length, conv.status]);
```

- [ ] **Step 5: Add `shimmer` to the connecting status text**

In the `connecting` state block (around lines 633-645), change the "Launching … handshake" copy so the status line shimmers. Replace:

```tsx
              <div style={{color: 'var(--faint)', fontSize: '11px'}}>
                handshake
              </div>
```

with:

```tsx
              <div
                className="shimmer"
                style={{fontSize: '11px'}}
              >
                handshake
              </div>
```

- [ ] **Step 6: Replace the stream container block**

Replace the entire `{/* Stream / state body */}` block — the opening `<div className="stream" ref={streamRef}>` through its closing `</div>` (lines 612-748) — with the MessageScroller tree below. The inner state-card JSX (`no-agent`, `connecting`, `doctor`, `crashed`, `rebuild`) is unchanged; only the wrapper, the message `.map`, and the streaming indicator change:

```tsx
        {/* Stream / state body */}
        <MessageScroller.Provider
          autoScroll
          defaultScrollPosition="end"
          scrollEdgeThreshold={48}
        >
          <MessageScroller.Root className="dock-stream-root">
            <MessageScroller.Viewport className="stream scroll-fade">
              <MessageScroller.Content className="dock-stream-content">
                {/* State: no-agent */}
                {dock.status === 'no-agent' && (
                  <div className="dock-empty">
                    <div className="dock-empty-title">No coding agent found</div>
                    <div>Install one to chat with your app.</div>
                    <code className="dock-install-hint">
                      npm i -g claude-agent-acp
                    </code>
                    <button
                      className="btn"
                      style={{marginTop: '8px'}}
                      onClick={() => dispatchDock({type: 'recheck'})}
                    >
                      Re-check
                    </button>
                  </div>
                )}

                {/* State: connecting */}
                {dock.status === 'connecting' && (
                  <div className="dock-empty">
                    <Spin size={16} />
                    <div>
                      Launching{' '}
                      <span className="badge">
                        {dock.selectedAgentId ?? 'agent'}
                      </span>
                      …
                    </div>
                    <div className="shimmer" style={{fontSize: '11px'}}>
                      handshake
                    </div>
                  </div>
                )}

                {/* State: doctor / wrong version */}
                {dock.status === 'doctor' && (
                  <div className="dock-empty">
                    <div
                      className="dock-empty-title"
                      style={{color: 'var(--accent)'}}
                    >
                      Adapter out of date
                    </div>
                    <div style={{fontSize: '12.5px', color: 'var(--muted)'}}>
                      {dock.doctorMessage ?? 'Version mismatch.'}
                    </div>
                    <code className="dock-install-hint">
                      npm i -g claude-agent-acp@latest
                    </code>
                    <button
                      className="btn"
                      style={{marginTop: '8px'}}
                      onClick={() => dispatchDock({type: 'restart'})}
                    >
                      Retry
                    </button>
                  </div>
                )}

                {/* State: crashed */}
                {dock.status === 'crashed' && (
                  <div className="dock-empty">
                    <div
                      className="dock-empty-title"
                      style={{color: 'var(--err)'}}
                    >
                      Agent stopped
                    </div>
                    <div style={{fontSize: '12.5px'}}>
                      {dock.crashMessage ?? 'The session ended unexpectedly.'}
                    </div>
                    <div style={{display: 'flex', gap: '8px', marginTop: '8px'}}>
                      <button
                        className="btn"
                        onClick={() => dispatchDock({type: 'restart'})}
                      >
                        Restart
                      </button>
                      <button className="btn ghost">View log</button>
                    </div>
                  </div>
                )}

                {/* State: rebuild (F5) */}
                {dock.status === 'rebuild' && (
                  <div className="dock-empty">
                    <div>Edited files.</div>
                    <div className="dock-empty-title">
                      Rebuild to see changes live
                    </div>
                    <button
                      className="btn"
                      style={{marginTop: '8px'}}
                      onClick={() => {
                        // Placeholder: Task 7 wires the real rebuild + reconnect.
                        dispatchDock({type: 'restart'});
                      }}
                    >
                      Rebuild &amp; reconnect
                    </button>
                    <div style={{color: 'var(--faint)', fontSize: '11px'}}>
                      watch build detected
                    </div>
                  </div>
                )}

                {/* Conversation messages (ready state) */}
                {(dock.status === 'ready' || conv.messages.length > 0) &&
                  dock.status !== 'no-agent' &&
                  dock.status !== 'connecting' &&
                  dock.status !== 'doctor' &&
                  dock.status !== 'rebuild' &&
                  conv.messages.map((msg, idx) => {
                    const isPerm = idx === lastAssistantIdx;
                    return (
                      <MessageScroller.Item
                        key={idx}
                        messageId={String(idx)}
                        scrollAnchor
                      >
                        <MessageBubble
                          msg={msg}
                          perm={isPerm ? permForLastAssistant : null}
                          onApprove={() =>
                            void resolvePermission(
                              conv.pendingPermission?.options[0]?.optionId ??
                                'allow_once',
                            )
                          }
                          onDeny={() => void resolvePermission(null)}
                          onScopeChange={handleScopeChange}
                        />
                      </MessageScroller.Item>
                    );
                  })}

                {/* Inline streaming indicator (shimmer) */}
                {dock.status === 'ready' && conv.status === 'streaming' && (
                  <div className="dock-streaming">
                    <Spin size={11} />
                    <span className="shimmer">Working…</span>
                  </div>
                )}
              </MessageScroller.Content>
            </MessageScroller.Viewport>

            {/* Jump-to-latest — only visible when scrolled away from the end */}
            <MessageScroller.Button
              direction="end"
              className="dock-jump"
              render={(props, state) =>
                state.active ? (
                  <button {...props} type="button">
                    ↓ jump to latest
                  </button>
                ) : null
              }
            />
          </MessageScroller.Root>
        </MessageScroller.Provider>
```

(Note: the per-message `MessageBubble` props are copied verbatim from the original `.map` at lines 725-738; the only structural change is wrapping each in `MessageScroller.Item`.)

- [ ] **Step 7: Typecheck the client bundle**

Run: `pnpm -F @agentback/console-chat build && pnpm typecheck:client`
Expected: both pass. If `typecheck:client` flags an unused `useEffect`/`useRef` or a `render`-prop signature mismatch, fix per the error (the `render` callback is `(props, state) => ReactElement | null` with `state: {active, direction}`).

- [ ] **Step 8: Build the client bundle and verify it includes MessageScroller**

Run: `node packages/console-chat/build-client.mjs && grep -c "dock-jump\|dock-stream-root" packages/console-chat/dist/client/main.js`
Expected: build logs success; grep prints `≥1` (the new classes are referenced in the bundle).

- [ ] **Step 9: Lint**

Run: `pnpm lint`
Expected: passes (no unused-var warnings for the removed `useRef`/`streamRef`).

- [ ] **Step 10: Manual verification in the example app**

Run: `pnpm -F hello-agent-console start` (or the example's documented start command), open the console, open the dock, and confirm:
1. Streaming a reply auto-follows the bottom.
2. Scrolling up mid-stream stops the follow and reveals "↓ jump to latest".
3. Clicking the button returns to the bottom and resumes following.
4. Top/bottom edge fades render on the viewport (in a scroll-driven-animation-capable browser).
5. The streaming/connecting status text shimmers; under OS "reduce motion" it is static.

If any check fails, treat it as a bug in this task and fix before committing.

- [ ] **Step 11: Commit**

```bash
git add packages/console-chat/src/client/Dock.tsx
git commit -m "feat(console-chat): MessageScroller-backed dock scroll + jump-to-latest

Replaces the manual scrollTop auto-scroll with @shadcn/react's headless
MessageScroller: stick-to-bottom-unless-scrolled-up plus a jump-to-latest
button. Adds shimmer to the streaming/connecting status text; keeps Spin as
the reduced-motion fallback.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Documentation sync + full verify

**Files:**
- Modify: `packages/console-chat/README.md`
- Modify: `packages/console-theme/README.md`
- Modify: `docs/guides/agent-console.md`

**Interfaces:**
- Consumes: the behavior shipped in Tasks 1-2.
- Produces: nothing.

- [ ] **Step 1: Document the dock scroll behavior in console-chat README**

Open `packages/console-chat/README.md`, find the section describing the dock UI / Dock component (search for "dock" or "stream"). Add a short paragraph:

```markdown
### Conversation scrolling

The dock's message list uses the headless `@shadcn/react` `MessageScroller`. It
auto-follows the newest token while the agent streams, but stops following if you
scroll up to read — a **↓ jump to latest** button then appears to return to the
bottom. The streaming and connecting status lines use the `shimmer` utility from
`@agentback/console-theme`; the spinner remains as the reduced-motion fallback.
```

(If no obviously matching section exists, add it under the existing top-level UI/feature description.)

- [ ] **Step 2: Document the new utilities in console-theme README**

Open `packages/console-theme/README.md`. Add (under an existing "utilities"/"classes" section, or as a new `## Utilities` section if none exists):

```markdown
## Utilities

- `.shimmer` — animated gradient text sweep for live status ("Working…", "handshake").
  Honors `prefers-reduced-motion` (renders static `--muted` text).
- `.scroll-fade` — scroll-aware top/bottom edge fade for scroll containers, via pure
  CSS (`animation-timeline: scroll()` + `mask-image`, no scroll listeners). Gated on
  `@supports`, so it is a no-op where unsupported (content stays fully visible).

Both are ports of the same-named shadcn/ui utilities, rewritten as plain CSS (the
console UIs do not use Tailwind).
```

- [ ] **Step 3: Note the UX in the agent-console guide**

Open `docs/guides/agent-console.md`, find where the chat dock UI is described, and add one line noting the stick-to-bottom + jump-to-latest scrolling and shimmering status text (so the guide matches the shipped behavior).

- [ ] **Step 4: Full local CI mirror**

Run: `pnpm verify`
Expected: build + typecheck:client + test + validate-templates all green. (No new tests were added — the changed surface is client TSX with no unit-test seam, per the spec; existing console-chat unit tests stay green because their logic is untouched.)

- [ ] **Step 5: Commit**

```bash
git add packages/console-chat/README.md packages/console-theme/README.md docs/guides/agent-console.md
git commit -m "docs(console): document MessageScroller dock scrolling + scroll-fade/shimmer utilities

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Scope item 1 (MessageScroller, stick + jump button) → Task 2 ✓
- Scope item 2 (scroll-fade + shimmer ported to console-theme, applied) → Task 1 (CSS) + Task 2 (applied to viewport/status text) ✓
- Dependency & build (add dep, not external, pnpm-11 caveat) → Task 1 Steps 1-2 + Global Constraints ✓
- Decision (a) Spin as reduced-motion fallback → Task 2 Step 6 (Spin kept) + Task 1 Step 3 (shimmer reduced-motion rule) ✓
- Decision (b) utilities in shared console-theme → Task 1 ✓
- Remove manual ref/effect → Task 2 Steps 2-4 ✓
- Edge cases (unsupported animation-timeline no-op, reduced-motion, empty conversation jump-button hidden via `state.active`) → Task 1 Step 3 (`@supports`/`@media`) + Task 2 Step 6 (`render` returns null when `!active`) ✓
- Testing/verification (typecheck:client, pnpm verify, manual) → Task 2 Steps 7-10, Task 3 Step 4 ✓
- Docs (both READMEs + agent-console guide) → Task 3 ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" in this plan's own steps. (The `Task 7` comment retained in the rebuild state JSX is pre-existing source text copied verbatim, not a plan placeholder.)

**Type consistency:** `MessageScroller` compound members (`Provider/Root/Viewport/Content/Item/Button`), the `render={(props, state) => …}` signature with `state.active`, and `messageId={String(idx)}` all match the package `.d.ts`. CSS class names (`dock-stream-root`, `dock-stream-content`, `dock-streaming`, `dock-jump`, `scroll-fade`, `shimmer`) are identical between Task 1 (definitions) and Task 2 (usages).
