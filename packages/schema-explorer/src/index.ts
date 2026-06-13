// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {CoreBindings, inject, type Context} from '@agentback/core';
import {THEME_CSS, THEME_FONTS_HREF} from '@agentback/console-theme';
import type {RestApplication, RestServer} from '@agentback/rest';
import {buildSchemaInventory} from './inventory.js';

export * from './inventory.js';

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

// ---- Controller (the dogfooded REST API) ------------------------------------

/**
 * Read-only JSON API over the application's domain schemas. Like
 * `context-explorer`, it's built with the framework's own `@api`/`@get`
 * decorators and registered via `app.restController(...)`, and injects the root
 * application context — but instead of indexing the container by binding, it
 * indexes it by *schema*: every Zod entity, with provenance edges to the REST
 * routes, MCP tools, and Drizzle tables that use it.
 */
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

  app.get([opts.path, opts.path + '/'], (_req, res) => {
    res.type('html').send(indexHtml(opts, hasCss));
  });
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
.schemax .detail { overflow:auto; padding:1.4rem 1.6rem; animation:rise .5s cubic-bezier(.2,.7,.3,1) both; }
.schemax .detail h2 { font-family:var(--mono); font-weight:500; color:var(--accent); font-size:1.1rem; word-break:break-all; margin:0 0 .3rem; }
.schemax .detail .sub { color:var(--muted); font-size:.8rem; margin:0 0 1.1rem; padding-bottom:.7rem; border-bottom:1px solid var(--line); }
.schemax .uses { margin-bottom:1.6rem; }
.schemax .uses h3, .schemax .fields h3 { font-family:var(--sans); font-size:.74rem; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--faint); margin:0 0 .6rem; }
.schemax .uses ul { list-style:none; margin:0; padding:0; }
.schemax .uses li { margin:.25rem 0; padding:.45rem .6rem; border:1px solid var(--line); border-radius:5px; display:flex; align-items:center; gap:.5rem; }
.schemax .uses .ref { font-family:var(--mono); font-size:12.5px; word-break:break-all; }
.schemax .uses .role { margin-left:auto; font-size:.72rem; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
.schemax .uses .empty { font-style:italic; color:var(--accent); }
.schemax pre.json { background:var(--card); border:1px solid var(--line-2); padding:1rem; border-radius:6px; white-space:pre-wrap; word-break:break-word; font-size:12px; font-family:var(--mono); margin:0; }
.schemax .empty { padding:2rem 0; color:var(--muted); }
.schemax .err { color:var(--accent); padding:1.5rem; font-family:var(--mono); }
.schemax .gtooltip { position:fixed; z-index:62; pointer-events:none; max-width:280px; background:var(--card); color:var(--ink); border:1px solid var(--line-2); border-radius:6px; padding:.6rem .7rem; box-shadow:0 14px 34px -18px rgba(34,29,22,.5); font-size:12px; }
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
