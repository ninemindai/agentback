// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Shared "newspaper" theme for the AgentBack developer UIs (context
 * explorer, REST/Swagger explorer, MCP inspector) and the unified console.
 *
 * This is the **common core** only: design tokens, the base reset/body/paper
 * grain, the `rise` keyframe, and the shared widget classes (`button.btn`,
 * `button.ghost`, `.badge`, `.empty`). Each tool appends its own component-
 * specific CSS after this. Injected once into a server-rendered shell's
 * `<style>`; components style via the CSS variables defined here, so they
 * render identically standalone or inside the console.
 */
export const THEME_CSS = `
:root {
  color-scheme: light;
  --paper:#f3efe4; --card:#fcfaf3; --ink:#221d16; --muted:#6f6555; --faint:#9b8f79;
  --line:#ddd3c0; --line-2:#cabfa6; --accent:#9a3324; --accent-soft:#c06a52; --blue:#2c4a6e;
  --ok:#4f6b39; --err:#9a3324; --badge:#eadfca; --badge-ink:#6a5d46;
  --serif:'Fraunces',Georgia,'Times New Roman',serif;
  --sans:'Hanken Grotesk',system-ui,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,'SFMono-Regular',monospace;
}
* { box-sizing:border-box; }
html { -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
body {
  margin:0; font-family:var(--sans); font-size:14px; line-height:1.5; color:var(--ink);
  background-color:var(--paper);
  background-image:
    linear-gradient(rgba(34,29,22,.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(34,29,22,.045) 1px, transparent 1px);
  background-size:27px 27px;
}
/* paper grain */
body::after {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:60; opacity:.16; mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");
}
@keyframes rise { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
button.btn { background:var(--accent); color:#fdf8ef; border:0; padding:.46rem .95rem; border-radius:5px; cursor:pointer; font:inherit; font-weight:500; letter-spacing:.01em; transition:background .15s; }
button.btn:hover { background:#812519; }
button.btn:disabled { opacity:.5; cursor:default; }
button.ghost { background:var(--card); border:1px solid var(--line-2); color:var(--ink); padding:.32rem .65rem; border-radius:5px; cursor:pointer; font:inherit; transition:border-color .15s,color .15s; }
button.ghost:hover { border-color:var(--accent); color:var(--accent); }
.badge { display:inline-block; background:var(--badge); color:var(--badge-ink); padding:.05rem .4rem; border-radius:3px; font-size:10.5px; font-family:var(--mono); letter-spacing:.01em; }
.empty { color:var(--muted); font-style:italic; }

/* ── Agent chat dock ────────────────────────────────────────────────────────── */
/* Layout: the dock is a fixed right-side slide-over panel (overlay) at ALL
   widths. It does NOT participate in the console grid -- that avoids the
   conflict with the shell's base 2-column console template (which wrapped a
   3rd grid child to the bottom-left). It overlays the panel and is toggled by
   the dock-toggle tab, which is a SIBLING of the dock (a position:fixed child
   of a transformed dock would be trapped in the transform and slide off
   screen with it). */
.dock {
  position:fixed; top:0; right:0; height:100vh; width:min(400px,94vw);
  display:flex; flex-direction:column; background:var(--card); min-width:0;
  border-left:1px solid var(--line-2); box-shadow:-6px 0 24px rgba(34,29,22,.12);
  transform:translateX(100%); transition:transform .2s ease; z-index:50;
}
.dock.dock--open { transform:none; }
/* Always-visible toggle tab pinned to the right edge; slides to the panel's
   left edge when open (so it doubles as the close affordance). */
.dock-toggle {
  position:fixed; right:0; top:50%; transform:translateY(-50%);
  display:flex; align-items:center; justify-content:center; gap:4px;
  background:var(--accent); color:#fdf8ef; border:0; cursor:pointer;
  border-radius:6px 0 0 6px; padding:10px 6px; font:inherit; font-size:11.5px;
  font-weight:500; writing-mode:vertical-rl; z-index:51;
  box-shadow:-2px 0 10px rgba(34,29,22,.14); transition:right .2s ease;
}
.dock-toggle--open { right:min(400px,94vw); }
.dock-head { padding:12px 14px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:8px; }
.picker { display:flex; align-items:center; gap:8px; min-width:0; }
.dot { width:7px; height:7px; border-radius:50%; background:var(--ok); flex:none; }
.dot.warn { background:var(--accent-soft); }
.dot.err  { background:var(--err); }
.dot.off  { background:var(--faint); }
.dock-name { font-weight:600; font-size:13px; }
.dock-adapter { font-family:var(--mono); font-size:10.5px; color:var(--faint); }
.dock-head .ghost { background:var(--card); border:1px solid var(--line-2); color:var(--muted); padding:.18rem .5rem; border-radius:5px; font:inherit; font-size:11.5px; cursor:pointer; }
.stream { flex:1; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:14px; }
.msg .who { font-family:var(--mono); font-size:10px; color:var(--faint); text-transform:uppercase; letter-spacing:.08em; margin-bottom:3px; }
.msg.user .bubble { background:var(--paper); border:1px solid var(--line); border-radius:6px; padding:.5rem .65rem; font-size:13px; }
.msg.assistant .bubble { font-size:13.5px; }
/* Tool-call activity block — mono, blue left border, mirrors mcp-inspector. */
.tool { font-family:var(--mono); font-size:11.5px; background:var(--paper); border:1px solid var(--line); border-left:2px solid var(--blue); border-radius:4px; padding:.4rem .55rem; margin:.5rem 0; color:var(--muted); }
.tool b { color:var(--ink); font-weight:500; }
/* Permission prompt — the trust moment: inline card, rust left border, never auto-dismisses. */
.perm { background:#fbf3ee; border:1px solid var(--line-2); border-left:3px solid var(--accent); border-radius:5px; padding:.65rem .7rem; }
.perm .q { font-weight:600; font-size:13px; margin-bottom:2px; }
.perm .detail { font-family:var(--mono); font-size:11px; color:var(--muted); margin-bottom:.55rem; }
.perm .acts { display:flex; gap:8px; }
.perm .acts button { min-height:44px; padding:.32rem .8rem; }
.perm .scope { margin-top:.5rem; font-size:11px; color:var(--faint); }
.perm .scope label { cursor:pointer; }
/* Composer */
.composer { border-top:1px solid var(--line); padding:10px 12px; }
.chip { display:inline-flex; align-items:center; gap:6px; background:var(--badge); color:var(--badge-ink); font-family:var(--mono); font-size:10.5px; padding:.12rem .45rem; border-radius:3px; margin-bottom:8px; }
.chip .x { cursor:pointer; color:var(--faint); font-weight:700; }
.inputrow { display:flex; gap:8px; align-items:center; }
.inputrow input { flex:1; font:inherit; font-size:13px; padding:.45rem .6rem; border:1px solid var(--line-2); border-radius:5px; background:var(--paper); color:var(--ink); }
.inputrow .send { background:var(--accent); color:#fdf8ef; border:0; border-radius:5px; padding:.45rem .7rem; cursor:pointer; font-size:12.5px; min-height:44px; }
/* Empty / no-agent state */
.dock-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; text-align:center; padding:24px 16px; color:var(--muted); font-size:12.5px; flex:1; }
.dock-empty-title { font-family:var(--serif); font-size:15px; color:var(--ink); }
.dock-install-hint { font-family:var(--mono); font-size:11px; display:block; }
/* Narrow viewports: let the panel use the full width. */
@media (max-width:520px) {
  .dock { width:100vw; }
  .dock-toggle--open { right:100vw; }
}

/* ── Markdown renderer (assistant bubbles in the dock) ──────────────────────
   .md-chat is the root container; all selectors are scoped to it so they
   don't leak into the rest of the console UI. Font/size inherit from the
   parent .msg.assistant .bubble (13.5 px sans). */
.md-chat { display:flex; flex-direction:column; gap:6px; }
.md-chat .md-p { margin:0; line-height:1.55; white-space:pre-wrap; }
/* Headings — serif, modest sizes, no top margin inside the bubble. */
.md-chat .md-h { font-family:var(--serif); font-weight:600; color:var(--ink); margin:0; line-height:1.3; }
.md-chat h1.md-h { font-size:15px; }
.md-chat h2.md-h { font-size:14px; }
.md-chat h3.md-h { font-size:13.5px; }
/* Fenced code block — mirrors the .tool mono look (blue left-border, paper bg). */
.md-chat .md-pre { margin:0; padding:.45rem .55rem; background:var(--paper); border:1px solid var(--line); border-left:2px solid var(--blue); border-radius:4px; overflow-x:auto; }
.md-chat .md-pre code { font-family:var(--mono); font-size:11.5px; color:var(--ink); background:none; border:none; padding:0; white-space:pre; }
/* Inline code. */
.md-chat code { font-family:var(--mono); font-size:11.5px; background:var(--paper); border:1px solid var(--line); border-radius:3px; padding:.05rem .3rem; color:var(--ink); }
/* Lists — compact, chat-sized. */
.md-chat .md-ul, .md-chat .md-ol { margin:0; padding-left:1.4em; }
.md-chat .md-ul li, .md-chat .md-ol li { line-height:1.5; }
/* Links — accent colour, no underline by default. */
.md-chat a { color:var(--accent); text-decoration:none; }
.md-chat a:hover { text-decoration:underline; }
/* strong / em */
.md-chat strong { font-weight:600; color:var(--ink); }
.md-chat em { font-style:italic; }
/* Tables — scrollable on the narrow dock, ruled cells, paper-tinted header. */
.md-chat .md-table { display:block; overflow-x:auto; border-collapse:collapse; margin:2px 0; font-size:12px; }
.md-chat .md-table th, .md-chat .md-table td { border:1px solid var(--line); padding:.28rem .5rem; text-align:left; vertical-align:top; }
.md-chat .md-table th { background:var(--paper); font-weight:600; color:var(--ink); white-space:nowrap; }
.md-chat .md-table code { font-size:11px; }
`;

/** The Google Fonts stylesheet href both shells preconnect to + load. */
export const THEME_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
