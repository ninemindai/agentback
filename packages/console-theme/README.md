# @agentback/console-theme

> Shared "newspaper" design tokens and base CSS for the AgentBack developer UIs.

A single source of truth for the visual shell used by `@agentback/console`, `@agentback/context-explorer`, `@agentback/schema-explorer`, `@agentback/rest-explorer`, and `@agentback/mcp-inspector`. Each tool injects this CSS once into its server-rendered `<style>` block, then appends its own component-specific rules on top.

```bash
pnpm add @agentback/console-theme
```

## What it provides

- `THEME_CSS` — a CSS string containing:
  - CSS custom properties (design tokens): `--paper`, `--card`, `--ink`, `--muted`, `--faint`, `--line`, `--line-2`, `--accent`, `--accent-soft`, `--blue`, `--ok`, `--err`, `--badge`, `--badge-ink`, `--serif`, `--sans`, `--mono`.
  - Base reset (`box-sizing`, font smoothing, `body` background with a subtle grid + paper-grain SVG texture).
  - `@keyframes rise` — fade-up entrance animation (`opacity 0→1`, `translateY 8px→0`).
  - Shared widget classes: `button.btn` (accent fill), `button.ghost` (bordered), `.badge` (monospace label chip), `.empty` (italic muted placeholder text).

- `THEME_FONTS_HREF` — the Google Fonts stylesheet URL that loads Fraunces (serif headings), Hanken Grotesk (sans body), and JetBrains Mono (monospace). Both shells `<link rel="preconnect">` to `fonts.googleapis.com` and load this href.

## Usage

```ts
import {THEME_CSS, THEME_FONTS_HREF} from '@agentback/console-theme';

// In a server-rendered HTML shell:
const html = `<!doctype html><html><head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="${THEME_FONTS_HREF}">
  <style>${THEME_CSS}
    /* tool-specific rules follow */
    .my-component { color: var(--accent); font-family: var(--serif); }
  </style>
</head><body>…</body></html>`;
```

## Utilities

- `.shimmer` — animated gradient text sweep for live status ("Working…", "handshake").
  Honors `prefers-reduced-motion` (renders static `--muted` text).
- `.scroll-fade` — scroll-aware top/bottom edge fade for scroll containers, via pure
  CSS (`animation-timeline: scroll()` + `mask-image`, no scroll listeners). Gated on
  `@supports`, so it is a no-op where unsupported (content stays fully visible).

Both are ports of the same-named shadcn/ui utilities, rewritten as plain CSS (the
console UIs do not use Tailwind).

## Layering

No runtime dependencies beyond `tslib`. Pure CSS + constants — no DOM, no React, no framework coupling. The UI packages consume it at build/render time; it does not appear in any OpenAPI spec or DI container.
