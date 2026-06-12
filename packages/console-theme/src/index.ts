// Copyright Ninemind.ai 2026. All Rights Reserved.
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
`;

/** The Google Fonts stylesheet href both shells preconnect to + load. */
export const THEME_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
