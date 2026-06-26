# Design: shadcn scroll/streaming polish for the ACP dock

**Date:** 2026-06-26
**Status:** Approved (pending spec review)
**Package(s):** `@agentback/console-chat`, `@agentback/console-theme`

## Problem

The console-chat agent dock (`packages/console-chat/src/client/Dock.tsx`) renders the
ACP coding-agent conversation. Its scroll handling is the naive version:

```ts
useEffect(() => {
  const el = streamRef.current;
  if (el) el.scrollTop = el.scrollHeight; // yanks to bottom on EVERY message change
}, [conv.messages.length, conv.status]);
```

This pulls the user back to the bottom on every streamed token. If the user scrolls
up to read mid-stream, every SSE delta drags them back down — the classic
streaming-chat scroll bug.

## Goal

Adopt the relevant pieces of shadcn/ui's June 2026 chat release (the headless
`@shadcn/react` `message-scroller` primitive + the `scroll-fade` / `shimmer` CSS
utilities) **without** introducing Tailwind or Radix, which the console UIs do not
use (they style with `console-theme` "newspaper" design tokens).

Two deliverables (scope items 1 & 2 from the brainstorm):

1. Replace the hand-rolled scroll with `@shadcn/react`'s `MessageScroller`, giving
   **stick-to-bottom-unless-scrolled-up** behavior plus a **"jump to latest ↓"** button.
2. Port `scroll-fade` and `shimmer` into `console-theme` as plain CSS; apply
   `scroll-fade` to the message viewport edges and `shimmer` to the
   streaming/connecting status text.

## Non-goals

- No styled shadcn `Bubble` / `Message` components, no Tailwind, no Radix. The
  `MessageBubble`, `ToolCallBlock`, and `PermissionCard` sub-components and the six
  dock states (`no-agent / connecting / doctor / crashed / rebuild / ready`) keep
  their existing console-theme styling.
- No changes to the SSE reducer, ACP session bridge, permission flow, or focus bus.
- No reuse extraction into other UIs in this change (the utilities land in the
  shared theme, but only the dock consumes them for now).

## Dependency & build

- Add `@shadcn/react@~0.1.0` to `packages/console-chat/package.json` dependencies.
  - Peer dep: `react >=19`, `@types/react >=19`. console-chat is on `react ~19.2.7`. ✓
  - Zero runtime dependencies; headless (no Tailwind/Radix). Subpath export
    `@shadcn/react/message-scroller`.
- It bundles into `dist/client/main.js` via esbuild. Do **not** add it to the
  `external` array in `build-client.mjs` — only `react`/`react-dom`/`react/jsx-runtime`
  stay external (provided by the console shell).
- One `pnpm install`. Note: pnpm 11's ~24h minimum-release-age policy may reject the
  version if just published — pin one patch older if `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.

## `MessageScroller` API (from the package's `.d.ts`)

Headless compound component + hooks:

- `MessageScroller.Provider` — props: `autoScroll`, `defaultScrollPosition`
  (`"start" | "end" | "last-anchor"`), `scrollEdgeThreshold`, `scrollPreviousItemPeek`,
  `scrollMargin`. Owns the "am I at the bottom?" state.
- `MessageScroller.Root` — outer `div`.
- `MessageScroller.Viewport` — the scrolling element (`preserveScrollOnPrepend?`).
- `MessageScroller.Content` — inner content wrapper (`spacerClassName?`).
- `MessageScroller.Item` — wraps each message (`messageId?`, `scrollAnchor?`).
- `MessageScroller.Button` — render-prop button exposing `{active, direction}`;
  `direction="end"` = jump-to-latest, only `active` when not already at the end.
- Hooks: `useMessageScroller()` (`scrollToEnd/scrollToMessage/scrollToStart`),
  `useMessageScrollerScrollable()`, `useMessageScrollerVisibility()`.

## Component change (`Dock.tsx`)

Restructure only the stream container. Pseudo-structure:

```
MessageScroller.Provider (autoScroll defaultScrollPosition="end" scrollEdgeThreshold≈48)
  MessageScroller.Root
    MessageScroller.Viewport  className="stream scroll-fade"   ← the scrolling element
      MessageScroller.Content
        // state cards render here exactly as today:
        //   no-agent / connecting / doctor / crashed / rebuild
        // conversation:
        conv.messages.map(...) → MessageScroller.Item messageId={idx} scrollAnchor
                                   └ <MessageBubble/>            ← unchanged
        // inline streaming indicator (shimmer)
    MessageScroller.Button direction="end" → ".dock-jump"  (↓ jump to latest)
```

Specific edits:

- Remove the `streamRef` ref (`Dock.tsx:352`) and the manual auto-scroll
  `useEffect` (`Dock.tsx:367`). The Provider owns scroll position.
- Wrap each rendered message in `MessageScroller.Item` keyed/`messageId`'d by index,
  `scrollAnchor` on so the library can anchor turns.
- Add a `.dock-jump` button via `MessageScroller.Button direction="end"`, positioned
  absolutely bottom-center of the viewport, console-theme styled. Its render-prop
  `active` flag gates visibility (hidden when already at bottom).
- Streaming indicator: the inline `Spin` (`Dock.tsx:743`) and the `connecting`
  "Launching …" text (`Dock.tsx:633`) get a `shimmer` class on their text.
  **Decision (a):** keep `Spin` as a `prefers-reduced-motion` fallback — shimmer is
  the motion enhancement, the spinner remains for users/agents with reduced motion.

The state cards remain inside `Content` so they scroll/center naturally; they are
not wrapped in `Item` (they are not conversation turns).

## `console-theme` CSS additions

**Decision (b):** add to the shared `console-theme` (general-purpose utilities, the
way shadcn ships them), not scoped to console-chat.

- `.scroll-fade` — top/bottom edge fade via `mask-image` + `animation-timeline: scroll()`
  (pure CSS, no scroll listeners — matches shadcn's "without scroll listeners"). Must
  degrade to a no-op (content fully visible) where scroll-driven animations are
  unsupported.
- `.shimmer` — animated gradient sweep using `background-clip: text` over
  `--muted → --ink`. Honors `prefers-reduced-motion: reduce` (renders static text).

Both use existing console-theme tokens; no new tokens introduced.

## Error handling / edge cases

- **Prepend history:** not currently a feature (the dock streams forward only), so
  `preserveScrollOnPrepend` is not needed now; leave default.
- **Empty conversation / state cards only:** Provider with no items must not error;
  the jump button stays hidden (`active=false`).
- **Reduced motion:** both shimmer and the jump-button transition respect
  `prefers-reduced-motion`; `Spin` fallback covers shimmer.
- **Unsupported `animation-timeline`:** `.scroll-fade` mask must default to no fade
  (full opacity) so content is never clipped.

## Testing & verification

The scroll logic now lives in the library, and `src/client` is esbuild-only — vitest
does not cover the TSX (it is typecheck-only via `tsconfig.client.json`, per CLAUDE.md).
There is no unit-test seam for DOM scroll behavior. Therefore:

- `pnpm typecheck:client` must pass (the real client-bundle gate).
- Existing `reducer.unit.ts`, `sse-reconnect.unit.ts`, `markdown.unit.ts`,
  `bridge.unit.ts`, `agents.unit.ts`, `framework-guide.unit.ts` stay green (their
  logic is untouched).
- `pnpm verify` (build + typecheck:client + test + validate-templates) green.
- Manual verification in `examples/hello-agent-console`:
  1. Stream a long reply; confirm it auto-follows the bottom.
  2. Scroll up mid-stream → following stops, "↓ jump to latest" appears.
  3. Click the button → returns to bottom, following resumes.
  4. Confirm top/bottom edge fades on the viewport.
  5. Confirm shimmer on the streaming/connecting status text; confirm static text
     under `prefers-reduced-motion`.

## Documentation surfaces (per CLAUDE.md doc-sync)

This changes two packages but adds no new package/decorator/port. Update in the same change:

- `packages/console-chat/README.md` — note the MessageScroller-backed scroll behavior.
- `packages/console-theme/README.md` — document the `scroll-fade` / `shimmer` utilities.
- `docs/guides/agent-console.md` — scroll/streaming UX note.

No `docs/packages.md` row change (no new package), no skill-table change.

## Open decisions (resolved)

- (a) Keep `Spin` as reduced-motion fallback alongside `shimmer` — **yes**.
- (b) Utilities live in shared `console-theme` — **yes**.
