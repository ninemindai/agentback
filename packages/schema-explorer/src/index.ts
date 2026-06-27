// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {
  BindingScope,
  CoreBindings,
  inject,
  injectable,
  type Context,
} from '@agentback/core';
import {THEME_CSS, THEME_FONTS_HREF} from '@agentback/console-theme';
import type {RestApplication, RestServer} from '@agentback/rest';
import {serveStaticDir} from '@agentback/rest';
import {buildSchemaInventory} from './inventory.js';
import {buildOkfBundle} from './okf.js';

export * from './inventory.js';
export * from './okf.js';

/** Fixed base path of the JSON API exposed by {@link SchemaExplorerController}. */
const API_BASE = '/schema-explorer/api';

export interface SchemaExplorerOptions {
  /** URL path where the explorer UI is mounted. Default `/schema-explorer`. */
  path?: string;
  /** Page title for the explorer. Default `Schema Explorer`. */
  title?: string;
}

const DEFAULTS: Required<SchemaExplorerOptions> = {
  path: '/schema-explorer',
  title: 'Schema Explorer',
};

// ---- Schemas ----------------------------------------------------------------

const Surface = z.enum(['rest', 'mcp']);

const SchemaUsage = z.object({
  surface: Surface,
  role: z.string(),
  ref: z.string(),
  surfaceId: z.string(),
  controller: z.string(),
  method: z.string(),
});

const SchemaNodeOrigin = z.object({
  table: z.string().optional(),
  kind: z.string().optional(),
  note: z.string().optional(),
});

const SchemaNode = z.object({
  id: z.string(),
  name: z.string(),
  bound: z.boolean(),
  bindingKey: z.string().optional(),
  origin: SchemaNodeOrigin.optional(),
  jsonSchema: z.unknown().optional(),
  fieldCount: z.number().optional(),
  usages: z.array(SchemaUsage),
});

const SchemaNodeList = z.array(SchemaNode);

const SchemaSurfaceNode = z.object({
  id: z.string(),
  surface: Surface,
  ref: z.string(),
  controller: z.string(),
  method: z.string(),
});

const SchemaEdge = z.object({
  from: z.string(),
  to: z.string(),
  role: z.string(),
  surface: Surface,
});

const SchemaGraph = z.object({
  nodes: SchemaNodeList,
  surfaces: z.array(SchemaSurfaceNode),
  edges: z.array(SchemaEdge),
});

type SchemaGraph = z.infer<typeof SchemaGraph>;

const OkfBundle = z.object({
  files: z.array(z.object({path: z.string(), content: z.string()})),
});

type OkfBundle = z.infer<typeof OkfBundle>;

// ---- Controller (the dogfooded REST API) ------------------------------------

/**
 * Read-only JSON API over the application's domain schemas. Like
 * `context-explorer`, it's built with the framework's own `@api`/`@get`
 * decorators and registered via `app.restController(...)`, and injects the root
 * application context — but instead of indexing the container by binding, it
 * indexes it by *schema*: every Zod entity, with provenance edges to the REST
 * routes, MCP tools, and Drizzle tables that use it.
 */
// Stateless, read-only: request state arrives via method params, never the
// constructor, so one shared instance is safe and avoids a per-request alloc.
@injectable({scope: BindingScope.SINGLETON})
@api({basePath: API_BASE})
export class SchemaExplorerController {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE) private readonly app: Context,
  ) {}

  /** Every schema node with its cross-protocol usages and emitted fields. */
  @get('/schemas', {response: SchemaNodeList})
  async schemas(): Promise<z.infer<typeof SchemaNodeList>> {
    return buildSchemaInventory(this.app).nodes;
  }

  /**
   * Provenance graph: schema nodes + the surface (route/tool) nodes they touch,
   * with role-labeled `schema -> surface` edges. Drives the graph view.
   */
  @get('/graph', {response: SchemaGraph})
  async graph(): Promise<SchemaGraph> {
    return buildSchemaInventory(this.app);
  }

  /**
   * The same schema graph serialized as an OKF (Open Knowledge Format) bundle:
   * a set of portable markdown docs. Drives the Knowledge tab's file tree and
   * the client-side `.zip` export; an agent can also fetch this directly.
   */
  @get('/okf', {response: OkfBundle})
  async okf(): Promise<OkfBundle> {
    return buildOkfBundle(this.app);
  }
}

// ---- Install / mount --------------------------------------------------------

/**
 * Register the {@link SchemaExplorerController} and mount the React UI on a
 * RestApplication. Call AFTER constructing the app but BEFORE `app.start()`.
 *
 * @example
 *   const app = new RestApplication();
 *   await installSchemaExplorer(app);
 *   await app.start();
 *   // -> Schema Explorer UI at http://host:port/schema-explorer/
 */
export async function installSchemaExplorer(
  app: RestApplication,
  options: SchemaExplorerOptions = {},
): Promise<void> {
  const opts = {...DEFAULTS, ...options};
  app.restController(SchemaExplorerController);
  const server: RestServer = await app.restServer;
  mountSchemaExplorer(server, opts);
}

/**
 * Server-side contribution for `@agentback/console`: registers the JSON API
 * controller (no standalone shell) and carries the panel's component CSS.
 * Paired with the `./console` client page.
 */
export function schemaConsoleFeature() {
  return {
    id: 'schema',
    apiBase: API_BASE,
    css: EXPLORER_CSS,
    install(app: RestApplication): void {
      app.restController(SchemaExplorerController);
    },
  };
}

/**
 * Lower-level form: mount the static UI on a RestServer instance whose context
 * already has {@link SchemaExplorerController} registered.
 */
export function mountSchemaExplorer(
  server: RestServer,
  options: SchemaExplorerOptions = {},
): void {
  const opts = {...DEFAULTS, ...options};
  const app = server.expressApp;
  const clientDir = fileURLToPath(new URL('./client/', import.meta.url));

  // Fail loud if the esbuild bundle is missing — no silent fallback.
  if (!existsSync(clientDir + 'main.js')) {
    throw new Error(
      '@agentback/schema-explorer: client bundle not found at ' +
        clientDir +
        'main.js. Run `pnpm build` (or `pnpm -F @agentback/schema-explorer build:client`) first.',
    );
  }

  app.use(opts.path + '/assets', express.static(clientDir, {index: false}));
  const hasCss = existsSync(clientDir + 'main.css');
  const html = indexHtml(opts, hasCss);

  app.get([opts.path, opts.path + '/'], (_req, res) => {
    res.type('html').send(html);
  });

  // Neutral fetch path (Bun/Deno/Fastify hosts via fetchHandler()).
  const serveAsset = serveStaticDir(clientDir);
  const htmlResponse = async () =>
    new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}});
  server.addFetchHandler('GET', opts.path, htmlResponse);
  server.addFetchHandler('GET', opts.path + '/', htmlResponse);
  server.addFetchPrefix(opts.path + '/assets', suffix => serveAsset(suffix));
}

// ---- Static shell -----------------------------------------------------------

function indexHtml(
  opts: Required<SchemaExplorerOptions>,
  hasCss: boolean,
): string {
  const cfg = JSON.stringify({apiBase: API_BASE, title: opts.title}).replace(
    /</g,
    '\\u003c',
  );
  const cssLink = hasCss
    ? `<link rel="stylesheet" href="${escapeAttr(opts.path)}/assets/main.css">`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${THEME_FONTS_HREF.replace(/&/g, '&amp;')}">
  ${cssLink}
  <style>${THEME_CSS}${EXPLORER_CSS}</style>
</head>
<body>
  <div id="root"></div>
  <script>window.__SCHEMA_EXPLORER__=${cfg}</script>
  <script type="module" src="${escapeAttr(opts.path)}/assets/main.js"></script>
</body>
</html>`;
}

// All rules are scoped under `.schemax` so the panel composes cleanly into the
// console alongside other panels' (unscoped) class names. Base tokens, reset,
// buttons and `.badge` come from @agentback/console-theme (THEME_CSS).
const EXPLORER_CSS = `
.schemax { display:flex; flex-direction:column; height:100vh; }
.schemax header { padding:.85rem 1.5rem; border-bottom:1px solid var(--line-2); display:flex; align-items:baseline; gap:1rem; background:rgba(252,250,243,.7); backdrop-filter:saturate(1.1); }
.schemax header h1 { font-family:var(--serif); font-weight:600; font-size:1.5rem; letter-spacing:-.01em; margin:0; }
.schemax header .count { color:var(--muted); font-size:.8rem; font-family:var(--mono); }
.schemax header .views { margin-left:auto; display:flex; gap:.4rem; }
.schemax .layout { display:grid; grid-template-columns:minmax(300px,380px) 1fr; gap:0; flex:1; min-height:0; }
.schemax .graphpane { flex:1; min-height:0; position:relative; }
.schemax .graphpane .react-flow__attribution { display:none; }
.schemax .graphpane .react-flow__controls { box-shadow:none; border:1px solid var(--line-2); border-radius:4px; overflow:hidden; }
.schemax .graphpane .react-flow__controls-button { background:var(--card); border-bottom:1px solid var(--line); color:var(--ink); }
.schemax .graphpane .react-flow__controls-button svg { fill:var(--ink); }
.schemax .list { border-right:1px solid var(--line-2); overflow:auto; padding:.9rem; }
.schemax .filter { width:100%; padding:.5rem .65rem; border:1px solid var(--line-2); border-radius:5px; background:var(--card); color:var(--ink); margin-bottom:.7rem; font:inherit; }
.schemax .filter:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(154,51,36,.12); }
.schemax .row { width:100%; text-align:left; border:1px solid transparent; background:none; color:inherit; padding:.5rem .6rem; border-radius:5px; cursor:pointer; display:block; font:inherit; animation:rise .4s cubic-bezier(.2,.7,.3,1) both; }
.schemax .row:hover { background:var(--card); border-color:var(--line); }
.schemax .row.sel { background:var(--card); border-color:var(--line-2); box-shadow:inset 3px 0 0 var(--accent); }
.schemax .row .name { font-family:var(--mono); font-size:13px; word-break:break-all; }
.schemax .row .name.synth { font-style:italic; color:var(--muted); }
.schemax .row .meta { margin-top:.3rem; display:flex; flex-wrap:wrap; gap:.3rem; align-items:center; }
.schemax .row:nth-child(1){animation-delay:.02s}.schemax .row:nth-child(2){animation-delay:.05s}.schemax .row:nth-child(3){animation-delay:.08s}.schemax .row:nth-child(4){animation-delay:.11s}.schemax .row:nth-child(5){animation-delay:.14s}.schemax .row:nth-child(n+6){animation-delay:.17s}
.schemax .badge.rest { color:var(--blue); border-color:color-mix(in srgb, var(--blue) 35%, transparent); }
.schemax .badge.mcp { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 35%, transparent); }
.schemax .badge.table { color:var(--muted); }
.schemax .badge.unused { color:var(--accent); border-style:dashed; }
.schemax .detail { overflow:auto; padding:1.5rem 1.8rem 3rem; animation:rise .5s cubic-bezier(.2,.7,.3,1) both; }
/* ---- masthead: the entity set as a reference-book entry ---- */
.schemax .entryhead { margin:0 0 1.6rem; padding-bottom:.85rem; border-bottom:2px solid var(--ink); position:relative; }
.schemax .entryhead::after { content:''; position:absolute; left:0; right:0; bottom:-4px; height:1px; background:var(--line-2); }
.schemax .eyebrow { font-family:var(--sans); font-size:.64rem; font-weight:700; text-transform:uppercase; letter-spacing:.15em; color:var(--accent); margin-bottom:.5rem; }
.schemax .eyebrow .fcount { color:var(--faint); font-weight:500; letter-spacing:.08em; }
.schemax .detail h2 { font-family:var(--serif); font-weight:600; font-size:2.15rem; line-height:1.04; letter-spacing:-.02em; color:var(--ink); margin:0; word-break:break-word; }
.schemax .entryhead .meta { display:flex; flex-wrap:wrap; gap:.5rem .9rem; margin-top:.7rem; align-items:center; }
.schemax .entryhead .mkey { font-family:var(--mono); font-size:11.5px; color:var(--muted); }
.schemax .entryhead .mtag { font-family:var(--mono); font-size:11.5px; color:var(--ink); background:var(--badge); border-radius:3px; padding:.12rem .5rem; display:inline-flex; align-items:center; gap:.4rem; }
.schemax .entryhead .mtag .g { color:var(--accent-soft); }
.schemax .entryhead .mtag em { font-style:normal; color:var(--muted); }
/* ---- provenance ledger ---- */
.schemax .uses { margin-bottom:1.9rem; }
.schemax .uses h3, .schemax .fields h3 { font-family:var(--sans); font-size:.68rem; font-weight:700; text-transform:uppercase; letter-spacing:.13em; color:var(--faint); margin:0 0 .7rem; }
.schemax .uses ul { list-style:none; margin:0; padding:0; border-top:1px solid var(--line); }
.schemax .use { display:flex; align-items:baseline; gap:.7rem; padding:.52rem .25rem .52rem .65rem; border-bottom:1px solid var(--line); position:relative; transition:padding-left .14s, background .14s; }
.schemax .use::before { content:''; position:absolute; left:0; top:-1px; bottom:-1px; width:2px; background:transparent; transition:background .14s; }
.schemax .use:hover { background:var(--card); padding-left:.85rem; }
.schemax .use.rest:hover::before { background:var(--blue); }
.schemax .use.mcp:hover::before { background:var(--accent); }
.schemax .umark { font-family:var(--sans); font-size:.58rem; font-weight:700; letter-spacing:.09em; text-transform:uppercase; padding:.14rem .42rem; border-radius:3px; flex:none; }
.schemax .umark.rest { color:var(--blue); background:color-mix(in srgb, var(--blue) 11%, transparent); }
.schemax .umark.mcp { color:var(--accent); background:color-mix(in srgb, var(--accent) 11%, transparent); }
.schemax .use .ref { font-family:var(--mono); font-size:12.5px; word-break:break-all; }
.schemax .use .role { margin-left:auto; font-size:.7rem; color:var(--muted); letter-spacing:.03em; display:inline-flex; align-items:center; gap:.28rem; flex:none; }
.schemax .use .role.out { color:var(--ok); }
.schemax .use .role .arrow { font-size:.9em; opacity:.8; }
.schemax .deadnote { font-style:italic; color:var(--accent); font-size:13px; padding:.7rem .85rem; border:1px dashed var(--accent-soft); border-radius:5px; background:color-mix(in srgb, var(--accent) 5%, transparent); }
/* ---- field-toggle + spec table ---- */
.schemax .fieldhead { display:flex; align-items:center; gap:.7rem; margin-bottom:.75rem; }
.schemax .fieldhead h3 { margin:0; }
.schemax .seg { margin-left:auto; display:inline-flex; border:1px solid var(--line-2); border-radius:5px; overflow:hidden; }
.schemax .seg button { border:0; background:var(--card); color:var(--muted); font-family:var(--mono); font-size:11px; letter-spacing:.03em; padding:.3rem .72rem; cursor:pointer; transition:color .14s, background .14s; }
.schemax .seg button:hover { color:var(--ink); }
.schemax .seg button.on { background:var(--accent); color:#fdf8ef; }
.schemax .seg button + button { border-left:1px solid var(--line-2); }
/* ---- ERD entity card ---- */
.schemax .ecard { border:1px solid var(--line-2); border-radius:7px; overflow:hidden; background:var(--card); box-shadow:0 1px 0 var(--line), 0 10px 26px -22px rgba(34,29,22,.5); }
.schemax .ecard-head { display:flex; align-items:baseline; gap:.6rem; padding:.55rem .85rem; background:linear-gradient(var(--paper), color-mix(in srgb, var(--paper) 60%, var(--card))); border-bottom:2px solid var(--ink); }
.schemax .ecard-head .etitle { font-family:var(--mono); font-weight:500; font-size:13.5px; color:var(--ink); letter-spacing:.01em; word-break:break-all; }
.schemax .ecard-head .ekind { margin-left:auto; font-family:var(--sans); font-size:.58rem; font-weight:700; text-transform:uppercase; letter-spacing:.12em; color:var(--faint); }
.schemax .erow { display:grid; grid-template-columns:14px minmax(92px,1.1fr) minmax(78px,auto) 1fr; gap:.6rem; align-items:baseline; padding:.44rem .85rem; border-bottom:1px solid var(--line); animation:rise .3s cubic-bezier(.2,.7,.3,1) both; }
.schemax .ecard-body > :last-child > .erow:last-child, .schemax .ecard-body > .erow:last-child { border-bottom:0; }
.schemax .erow:hover { background:var(--paper); }
.schemax .pip { align-self:center; width:7px; height:7px; border-radius:50%; flex:none; }
.schemax .pip.req { background:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 16%, transparent); }
.schemax .pip.opt { border:1px solid var(--line-2); }
.schemax .ename { font-family:var(--mono); font-size:12.5px; color:var(--ink); word-break:break-word; }
.schemax .etype { font-family:var(--mono); font-size:12px; color:var(--blue); display:inline-flex; align-items:center; gap:.3rem; word-break:break-word; }
.schemax .etype .caret { color:var(--faint); font-size:.8em; }
.schemax .econ { display:flex; flex-wrap:wrap; gap:.3rem; align-items:center; }
.schemax .efmt { font-size:12px; color:var(--accent); line-height:1; }
.schemax .echip { font-family:var(--mono); font-size:10.5px; color:var(--badge-ink); background:var(--badge); border-radius:3px; padding:.07rem .42rem; white-space:nowrap; }
.schemax .edesc { font-size:11.5px; color:var(--faint); font-style:italic; padding:0 .85rem .4rem 1.95rem; border-bottom:1px solid var(--line); }
.schemax .enest { padding:.35rem .6rem .55rem 1.55rem; position:relative; }
.schemax .enest::before { content:''; position:absolute; left:.9rem; top:-.1rem; bottom:.85rem; width:1px; background:var(--line-2); }
.schemax .ecard.nested { border-radius:6px; box-shadow:none; border-color:var(--line); }
.schemax pre.json { background:var(--card); border:1px solid var(--line-2); padding:1rem; border-radius:6px; white-space:pre-wrap; word-break:break-word; font-size:12px; line-height:1.55; font-family:var(--mono); margin:0; }
.schemax .empty { padding:2rem 0; color:var(--muted); }
.schemax .err { color:var(--accent); padding:1.5rem; font-family:var(--mono); }
.schemax .gtooltip { position:fixed; z-index:62; pointer-events:none; max-width:280px; background:var(--card); color:var(--ink); border:1px solid var(--line-2); border-radius:6px; padding:.6rem .7rem; box-shadow:0 14px 34px -18px rgba(34,29,22,.5); font-size:12px; }
/* ---- graph: hover peek + detail drawer ---- */
.schemax .graphwrap { position:relative; width:100%; height:100%; }
.schemax .hovercard { position:absolute; z-index:60; pointer-events:none; max-width:240px; background:var(--card); border:1px solid var(--line-2); border-radius:6px; padding:.55rem .65rem; box-shadow:0 14px 34px -18px rgba(34,29,22,.5); }
.schemax .hovercard .hc-eyebrow { font-family:var(--sans); font-size:.56rem; font-weight:700; text-transform:uppercase; letter-spacing:.13em; color:var(--accent); }
.schemax .hovercard .hc-name { font-family:var(--mono); font-size:13px; color:var(--ink); margin:.15rem 0 .3rem; word-break:break-word; }
.schemax .hovercard .hc-meta { display:flex; flex-wrap:wrap; gap:.5rem; font-size:11px; color:var(--faint); margin-bottom:.35rem; }
.schemax .hovercard .hc-tag { font-family:var(--mono); color:var(--ink); }
.schemax .hovercard .hc-tag .g { color:var(--accent-soft); margin-right:.2rem; }
.schemax .hovercard .hc-fields { list-style:none; margin:0; padding:.3rem 0 0; border-top:1px solid var(--line); }
.schemax .hovercard .hc-fields li { display:flex; justify-content:space-between; gap:.7rem; font-family:var(--mono); font-size:11.5px; padding:.1rem 0; }
.schemax .hovercard .hc-fields .fn { color:var(--ink); }
.schemax .hovercard .hc-fields .ft { color:var(--blue); }
.schemax .hovercard .hc-fields .more { color:var(--faint); font-style:italic; justify-content:flex-start; }
.schemax .drawer { position:absolute; top:12px; right:12px; max-height:calc(100% - 24px); width:560px; max-width:92%; overflow:auto; background:var(--paper); border:1px solid var(--line-2); border-radius:8px; box-shadow:0 24px 50px -28px rgba(34,29,22,.55); padding:2rem 1.6rem 1.4rem; z-index:61; animation:slidein .18s cubic-bezier(.2,.7,.3,1) both; }
.schemax .drawer-close { position:absolute; top:.5rem; right:.6rem; border:1px solid var(--line-2); background:var(--card); color:var(--ink); width:26px; height:26px; border-radius:5px; font-size:16px; line-height:1; cursor:pointer; }
.schemax .drawer-close:hover { border-color:var(--accent); color:var(--accent); }
/* Drawer is narrower than the Browse detail pane — long route-derived schema
   names (e.g. "GET /x/api/inspect · response") need a smaller masthead. */
.schemax .drawer .detail h2 { font-size:1.2rem; line-height:1.2; word-break:normal; overflow-wrap:break-word; }
@keyframes slidein { from { transform:translateX(12px); opacity:0; } to { transform:none; opacity:1; } }
/* ---- Knowledge tab: OKF file tree + rendered markdown ---- */
.schemax .okf { display:grid; grid-template-columns:minmax(220px,300px) 1fr; flex:1; min-height:0; }
.schemax .okf-tree { border-right:1px solid var(--line-2); overflow:auto; padding:.9rem; }
.schemax .okf-export { position:relative; margin-bottom:.8rem; }
.schemax .okf-menu { position:absolute; z-index:5; margin-top:.3rem; background:var(--card); border:1px solid var(--line-2); border-radius:6px; box-shadow:0 14px 34px -18px rgba(34,29,22,.5); overflow:hidden; min-width:170px; }
.schemax .okf-menu button { display:block; width:100%; text-align:left; border:0; background:none; color:var(--ink); padding:.5rem .7rem; font:inherit; cursor:pointer; }
.schemax .okf-menu button:hover { background:var(--paper); }
.schemax .okf-group { margin-bottom:.7rem; }
.schemax .okf-dir { font-family:var(--mono); font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:.08em; padding:.2rem .3rem; }
.schemax .okf-file { width:100%; text-align:left; border:1px solid transparent; background:none; color:inherit; padding:.35rem .55rem; border-radius:5px; cursor:pointer; display:block; font-family:var(--mono); font-size:12.5px; }
.schemax .okf-file:hover { background:var(--card); border-color:var(--line); }
.schemax .okf-file.sel { background:var(--card); border-color:var(--line-2); box-shadow:inset 3px 0 0 var(--accent); }
.schemax .okf-tree .filter { margin-bottom:.8rem; }
.schemax .okf-doc { overflow:auto; padding:1.2rem 2.4rem 2rem; }
.schemax .okf-doc .md { max-width:760px; }
.schemax .okf-docbar { display:flex; align-items:center; gap:1rem; margin-bottom:1.2rem; padding-bottom:.7rem; border-bottom:1px solid var(--line); position:sticky; top:-1.2rem; background:linear-gradient(var(--paper) 70%, transparent); }
.schemax .okf-path { font-family:var(--mono); font-size:12px; color:var(--muted); }
.schemax .okf-rawtoggle { margin-left:auto; font-size:11px; padding:.25rem .6rem; }
.schemax .okf-rawtoggle.on { background:var(--card); border-color:var(--accent); color:var(--accent); }
.schemax .okf-raw { font-family:var(--mono); font-size:12.5px; line-height:1.6; white-space:pre-wrap; word-break:break-word; max-width:820px; color:var(--ink); margin:0; }
.schemax .md h2 { font-family:var(--serif); font-weight:600; font-size:1.6rem; margin:.2rem 0 1rem; }
.schemax .md h3 { font-family:var(--serif); font-weight:600; font-size:1.15rem; margin:1.6rem 0 .6rem; }
.schemax .md p { line-height:1.6; margin:.6rem 0; color:var(--ink); }
.schemax .md ul { margin:.5rem 0; padding-left:1.2rem; }
.schemax .md li { line-height:1.7; }
.schemax .md a { color:var(--blue); text-decoration:none; border-bottom:1px solid color-mix(in srgb, var(--blue) 30%, transparent); cursor:pointer; }
.schemax .md a:hover { border-bottom-color:var(--blue); }
.schemax .md code { font-family:var(--mono); font-size:.86em; background:var(--badge); color:var(--badge-ink); border-radius:3px; padding:.05rem .35rem; }
.schemax .md table { border-collapse:collapse; width:100%; margin:.8rem 0; font-size:13px; }
.schemax .md th, .schemax .md td { text-align:left; padding:.4rem .65rem; border-bottom:1px solid var(--line); }
.schemax .md th { font-family:var(--sans); font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
.schemax .md td { font-family:var(--mono); font-size:12.5px; }
.schemax .md .fm { display:grid; grid-template-columns:max-content 1fr; gap:.15rem .8rem; margin:0 0 1.4rem; padding:.7rem .9rem; background:var(--card); border:1px solid var(--line); border-radius:6px; font-size:12px; }
.schemax .md .fm dt { font-family:var(--sans); font-size:10.5px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
.schemax .md .fm dd { margin:0; font-family:var(--mono); color:var(--ink); }
`;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        c
      ]!,
  );
}

function escapeAttr(s: string): string {
  return s.replace(/["&]/g, c => ({'"': '&quot;', '&': '&amp;'})[c]!);
}
