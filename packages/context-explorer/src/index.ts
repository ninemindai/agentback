// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {
  CoreBindings,
  inject,
  type Context,
  type JSONObject,
} from '@agentback/core';
import {THEME_CSS, THEME_FONTS_HREF} from '@agentback/console-theme';
import type {RestApplication, RestServer} from '@agentback/rest';

/** Fixed base path of the JSON API exposed by {@link ContextExplorerController}. */
const API_BASE = '/context-explorer/api';

export interface ContextExplorerOptions {
  /** URL path where the explorer UI is mounted. Default `/context-explorer`. */
  path?: string;
  /** Page title for the explorer. Default `Context Explorer`. */
  title?: string;
}

const DEFAULTS: Required<ContextExplorerOptions> = {
  path: '/context-explorer',
  title: 'Context Explorer',
};

// ---- Schemas ----------------------------------------------------------------

// `?flag=false` must actually mean false. z.coerce.boolean() would treat the
// non-empty string "false" as true, so parse the literal instead.
const boolFlag = z
  .enum(['true', 'false'])
  .optional()
  .transform(v => (v === undefined ? undefined : v === 'true'));

const InspectQuery = z.object({
  includeInjections: boolFlag,
  includeParent: boolFlag,
});

/**
 * Permissive wrapper for the recursive `Context.inspect()` dump. The shape is
 * recursive and not worth fully typing; this is loose enough to never reject a
 * real dump while still emitting a useful entry into `/openapi.json`.
 */
const ContextInspection = z
  .object({
    name: z.string().optional(),
    bindings: z.record(z.string(), z.any()),
    parent: z.any().optional(),
  })
  .loose();

const BindingSummary = z.object({
  key: z.string(),
  context: z.string(),
  scope: z.string(),
  type: z.string().optional(),
  source: z.string().optional(),
  tags: z.array(z.string()),
  isLocked: z.boolean().optional(),
});

const BindingSummaryList = z.array(BindingSummary);

type BindingSummary = z.infer<typeof BindingSummary>;

const GraphNode = z.object({
  key: z.string(),
  scope: z.string(),
  type: z.string().optional(),
});

// `from` depends on `to` (i.e. `from` injects the binding `to`).
const GraphEdge = z.object({
  from: z.string(),
  to: z.string(),
});

const ContextGraph = z.object({
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});

type ContextGraph = z.infer<typeof ContextGraph>;

// ---- Flatten ----------------------------------------------------------------

/**
 * Flatten a `Context.inspect()` tree into a sortable list of binding summaries,
 * walking the parent-context chain. Each summary records which context owns the
 * binding so the UI can group by context.
 */
function flattenInspection(node: JSONObject): BindingSummary[] {
  const out: BindingSummary[] = [];
  const ctxName = typeof node.name === 'string' ? node.name : '';
  const bindings = (node.bindings ?? {}) as Record<string, JSONObject>;
  for (const [key, b] of Object.entries(bindings)) {
    const source =
      (b.valueConstructor as string | undefined) ??
      (b.providerConstructor as string | undefined) ??
      (b.alias as string | undefined);
    out.push({
      key,
      context: ctxName,
      scope: String(b.scope ?? ''),
      type: b.type != null ? String(b.type) : undefined,
      source,
      tags: Object.keys((b.tags as JSONObject | undefined) ?? {}),
      isLocked: typeof b.isLocked === 'boolean' ? b.isLocked : undefined,
    });
  }
  const parent = node.parent as JSONObject | undefined;
  if (parent) out.push(...flattenInspection(parent));
  return out;
}

/**
 * Build a dependency graph from an `inspect({includeInjections: true})` tree.
 * Each binding becomes a node; each injection (constructor arg or property)
 * whose target is also a known binding becomes a `from -> to` edge meaning
 * "`from` depends on `to`". Edges to unbound keys (e.g. optional injections)
 * and self-edges are dropped so the graph only contains resolvable wiring.
 */
function extractGraph(node: JSONObject): ContextGraph {
  const nodes = new Map<string, z.infer<typeof GraphNode>>();
  const edgeSet = new Set<string>();
  const edges: ContextGraph['edges'] = [];

  // Pass 1: collect every binding as a node (across the parent chain).
  (function collect(n: JSONObject) {
    const bindings = (n.bindings ?? {}) as Record<string, JSONObject>;
    for (const [key, b] of Object.entries(bindings)) {
      if (!nodes.has(key)) {
        nodes.set(key, {
          key,
          scope: String(b.scope ?? ''),
          type: b.type != null ? String(b.type) : undefined,
        });
      }
    }
    if (n.parent) collect(n.parent as JSONObject);
  })(node);

  // A binding address may carry a property path after `#` (e.g.
  // `restServer.config#port`); the key itself contains dots, so only strip
  // the `#` suffix to recover the bound key.
  const baseKey = (addr: string) => addr.split('#')[0]!;

  // Pass 2: walk injections into edges.
  (function link(n: JSONObject) {
    const bindings = (n.bindings ?? {}) as Record<string, JSONObject>;
    for (const [key, b] of Object.entries(bindings)) {
      const inj = b.injections as JSONObject | undefined;
      if (!inj) continue;
      const targets: string[] = [];
      const ctorArgs =
        (inj.constructorArguments as JSONObject[] | undefined) ?? [];
      for (const a of ctorArgs) {
        if (typeof a?.bindingKey === 'string') targets.push(a.bindingKey);
      }
      const props =
        (inj.properties as Record<string, JSONObject> | undefined) ?? {};
      for (const p of Object.values(props)) {
        if (typeof p?.bindingKey === 'string') targets.push(p.bindingKey);
      }
      for (const t of targets) {
        const to = baseKey(t);
        if (to === key || !nodes.has(to)) continue; // drop self/dangling edges
        const id = key + '' + to;
        if (edgeSet.has(id)) continue;
        edgeSet.add(id);
        edges.push({from: key, to});
      }
    }
    if (n.parent) link(n.parent as JSONObject);
  })(node);

  return {nodes: [...nodes.values()], edges};
}

// ---- Controller (the dogfooded REST API) ------------------------------------

/**
 * Read-only JSON API over the application's DI container. Built with the
 * framework's own `@api`/`@get` decorators and registered via
 * `app.restController(...)` — unlike `mcp-inspector`, which mounts raw express
 * routes. Injects the root application context so it can introspect the full
 * registry and parent chain.
 */
@api({basePath: API_BASE})
export class ContextExplorerController {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE) private readonly app: Context,
  ) {}

  /** Flattened, sortable summary of every binding across the context chain. */
  @get('/bindings', {response: BindingSummaryList})
  async bindings(): Promise<BindingSummary[]> {
    return flattenInspection(this.app.inspect({includeParent: true}));
  }

  /** Full nested `inspect()` tree, including the parent-context chain. */
  @get('/inspect', {query: InspectQuery, response: ContextInspection})
  async inspect(input: {
    query: z.infer<typeof InspectQuery>;
  }): Promise<z.infer<typeof ContextInspection>> {
    return this.app.inspect({
      includeInjections: input.query.includeInjections ?? true,
      includeParent: input.query.includeParent ?? true,
    }) as z.infer<typeof ContextInspection>;
  }

  /**
   * Dependency graph of the container: a node per binding and a `from -> to`
   * edge for each injection (`from` depends on `to`). Drives the graph view.
   */
  @get('/graph', {response: ContextGraph})
  async graph(): Promise<ContextGraph> {
    return extractGraph(
      this.app.inspect({includeInjections: true, includeParent: true}),
    );
  }
}

// ---- Install / mount --------------------------------------------------------

/**
 * Register the {@link ContextExplorerController} and mount the React UI on a
 * RestApplication. Call AFTER constructing the app but BEFORE `app.start()`.
 *
 * @example
 *   const app = new RestApplication();
 *   await installContextExplorer(app);
 *   await app.start();
 *   // -> Context Explorer UI at http://host:port/context-explorer/
 */
export async function installContextExplorer(
  app: RestApplication,
  options: ContextExplorerOptions = {},
): Promise<void> {
  const opts = {...DEFAULTS, ...options};
  app.restController(ContextExplorerController);
  const server: RestServer = await app.restServer;
  mountContextExplorer(server, opts);
}

/**
 * Server-side contribution for `@agentback/console`: registers the JSON
 * API controller (no standalone shell) and carries the panel's component CSS.
 * Paired with the `./console` client page. The console maps this `id`/`apiBase`
 * to its panel.
 */
export function contextConsoleFeature() {
  return {
    id: 'context',
    apiBase: API_BASE,
    css: EXPLORER_CSS,
    install(app: RestApplication): void {
      app.restController(ContextExplorerController);
    },
  };
}

/**
 * Lower-level form: mount the static UI on a RestServer instance whose context
 * already has {@link ContextExplorerController} registered. Useful when you
 * resolved the server separately.
 */
export function mountContextExplorer(
  server: RestServer,
  options: ContextExplorerOptions = {},
): void {
  const opts = {...DEFAULTS, ...options};
  const app = server.expressApp;
  const clientDir = fileURLToPath(new URL('./client/', import.meta.url));

  // Fail loud if the esbuild bundle is missing — no silent fallback.
  if (!existsSync(clientDir + 'main.js')) {
    throw new Error(
      '@agentback/context-explorer: client bundle not found at ' +
        clientDir +
        'main.js. Run `pnpm build` (or `pnpm -F @agentback/context-explorer build:client`) first.',
    );
  }

  // Static bundle (and its sourcemap) under <path>/assets.
  app.use(opts.path + '/assets', express.static(clientDir, {index: false}));

  // esbuild emits main.css alongside main.js when the client imports CSS
  // (React Flow's stylesheet). Link it only if present.
  const hasCss = existsSync(clientDir + 'main.css');

  // Server-rendered shell at both <path> and <path>/ — no user data is
  // interpolated except the (escaped) title, so it is XSS-safe; the React tree
  // renders client-side from the API.
  app.get([opts.path, opts.path + '/'], (_req, res) => {
    res.type('html').send(indexHtml(opts, hasCss));
  });
}

// ---- Static shell -----------------------------------------------------------

function indexHtml(
  opts: Required<ContextExplorerOptions>,
  hasCss: boolean,
): string {
  // Config consumed by the client. apiBase is a fixed constant; title is
  // JSON-encoded with `<` escaped so it cannot break out of the script.
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
  <script>window.__CTX_EXPLORER__=${cfg}</script>
  <script type="module" src="${escapeAttr(opts.path)}/assets/main.js"></script>
</body>
</html>`;
}

// Tokens, reset, body/paper-grain, @keyframes rise, button.btn/.ghost and base
// .badge live in @agentback/console-theme (THEME_CSS), injected before
// this block. Only context-explorer-specific rules remain here.
const EXPLORER_CSS = `
header { padding:.85rem 1.5rem; border-bottom:1px solid var(--line-2); display:flex; align-items:baseline; gap:1rem; background:rgba(252,250,243,.7); backdrop-filter:saturate(1.1); }
header h1 { font-family:var(--serif); font-weight:600; font-size:1.5rem; letter-spacing:-.01em; margin:0; }
header .count { color:var(--muted); font-size:.8rem; font-family:var(--mono); }
header .views { margin-left:auto; display:flex; gap:.4rem; }
.layout { display:grid; grid-template-columns:minmax(320px,400px) 1fr; gap:0; height:calc(100vh - 56px); }
.graphpane { height:calc(100vh - 56px); position:relative; }
.graphpane .react-flow__attribution { display:none; }
.graphpane .react-flow__controls { box-shadow:none; border:1px solid var(--line-2); border-radius:4px; overflow:hidden; }
.graphpane .react-flow__controls-button { background:var(--card); border-bottom:1px solid var(--line); color:var(--ink); }
.graphpane .react-flow__controls-button:hover { background:var(--paper); }
.graphpane .react-flow__controls-button svg { fill:var(--ink); }
.graphpane .react-flow__minimap { border:1px solid var(--line-2); border-radius:4px; }
.gtooltip { position:fixed; z-index:62; pointer-events:none; max-width:260px; background:var(--card); color:var(--ink); border:1px solid var(--line-2); border-radius:6px; padding:.6rem .7rem; box-shadow:0 14px 34px -18px rgba(34,29,22,.5); font-size:12px; }
.gtooltip .k { font-family:var(--mono); font-weight:500; color:var(--accent); word-break:break-all; margin-bottom:.4rem; }
.gtooltip dl { display:grid; grid-template-columns:auto 1fr; gap:.15rem .6rem; margin:0; }
.gtooltip dt { color:var(--muted); }
.gtooltip dd { margin:0; font-family:var(--mono); word-break:break-all; }
.list { border-right:1px solid var(--line-2); overflow:auto; padding:.9rem; }
.filter { width:100%; padding:.5rem .65rem; border:1px solid var(--line-2); border-radius:5px; background:var(--card); color:var(--ink); margin-bottom:.7rem; font:inherit; }
.filter:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(154,51,36,.12); }
.tagfilter { font-size:.78rem; color:var(--muted); margin-bottom:.6rem; }
.tagfilter button { margin-left:.4rem; }
.row { width:100%; text-align:left; border:1px solid transparent; background:none; color:inherit; padding:.5rem .6rem; border-radius:5px; cursor:pointer; display:block; font:inherit; animation:rise .4s cubic-bezier(.2,.7,.3,1) both; }
.row:hover { background:var(--card); border-color:var(--line); }
.row.sel { background:var(--card); border-color:var(--line-2); box-shadow:inset 3px 0 0 var(--accent); }
.row .key { font-family:var(--mono); font-size:12.5px; word-break:break-all; }
.row .meta { margin-top:.3rem; display:flex; flex-wrap:wrap; gap:.3rem; }
.row:nth-child(1){animation-delay:.02s}.row:nth-child(2){animation-delay:.05s}.row:nth-child(3){animation-delay:.08s}.row:nth-child(4){animation-delay:.11s}.row:nth-child(5){animation-delay:.14s}.row:nth-child(6){animation-delay:.17s}.row:nth-child(7){animation-delay:.2s}.row:nth-child(8){animation-delay:.23s}.row:nth-child(9){animation-delay:.26s}.row:nth-child(n+10){animation-delay:.29s}
.badge.tag { cursor:pointer; }
.badge.tag:hover { color:var(--accent); }
.detail { overflow:auto; padding:1.4rem 1.6rem; animation:rise .5s cubic-bezier(.2,.7,.3,1) both; }
.detail h2 { font-family:var(--mono); font-weight:500; color:var(--accent); font-size:1.05rem; word-break:break-all; margin:0 0 1.1rem; padding-bottom:.7rem; border-bottom:1px solid var(--line); }
.detail dl { display:grid; grid-template-columns:130px 1fr; gap:.45rem .8rem; margin:0; }
.detail dt { color:var(--muted); font-size:.82rem; text-transform:uppercase; letter-spacing:.05em; padding-top:.05rem; }
.detail dd { margin:0; font-family:var(--mono); font-size:12.5px; word-break:break-all; }
.deps { margin-top:1.6rem; }
.deps h3 { font-family:var(--sans); font-size:.74rem; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:var(--faint); margin:0 0 .5rem; }
.deps h3 .count { letter-spacing:0; color:var(--muted); }
.deps ul { list-style:none; margin:0; padding:0; }
.deps li { margin:.18rem 0; padding-left:.8rem; border-left:1px solid var(--line); }
.deps .empty { padding:.1rem 0 .1rem .8rem; font-style:italic; }
button.dep { background:none; border:0; padding:0; color:var(--blue); cursor:pointer; font-family:var(--mono); font-size:12.5px; text-align:left; word-break:break-all; }
button.dep:hover { color:var(--accent); text-decoration:underline; text-underline-offset:2px; }
.empty { padding:2rem 0; }
pre.raw { background:var(--card); border:1px solid var(--line-2); padding:1rem; border-radius:6px; white-space:pre-wrap; word-break:break-word; font-size:12px; font-family:var(--mono); }
.err { color:var(--accent); padding:1.5rem; font-family:var(--mono); }
`;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );
}

function escapeAttr(s: string): string {
  return s.replace(/["&]/g, c => ({'"': '&quot;', '&': '&amp;'})[c]!);
}
