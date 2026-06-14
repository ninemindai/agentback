// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {z} from 'zod';
import {api, get, post, schemaToOpenApiSchema} from '@agentback/openapi';
import {BindingScope, inject, injectable} from '@agentback/core';
import {MCPBindings, type MCPServer} from '@agentback/mcp';
import {
  installMcpConnect,
  type McpConnectOptions,
} from '@agentback/mcp-connect';
import {THEME_CSS, THEME_FONTS_HREF} from '@agentback/console-theme';
import type {RestApplication, RestServer} from '@agentback/rest';

const API_BASE = '/mcp-inspector/api';
const DEFAULT_CONNECT_PATH = '/mcp-connect';

export interface InspectorOptions {
  /** URL path where the inspector UI is mounted. Default `/mcp-inspector`. */
  path?: string;
  /** Page title. Default `MCP Inspector`. */
  title?: string;
  /**
   * Enable **remote-connect mode**: a target switcher + "add remote server"
   * panel that connects to external MCP servers (none/bearer/OAuth) and proxies
   * their tools, via `@agentback/mcp-connect`. `true` mounts mcp-connect at
   * its default `/mcp-connect`; pass {@link McpConnectOptions} to customize the
   * path or reuse an existing registry. Omit to keep the inspector local-only.
   */
  connect?: boolean | McpConnectOptions;
}

/** Where the UI finds the mcp-connect API + OAuth callback (null = disabled). */
interface ConnectShellConfig {
  base: string;
  callbackPath: string;
}

const DEFAULTS = {
  path: '/mcp-inspector',
  title: 'MCP Inspector',
};

// ---- Schemas ----------------------------------------------------------------

const NamePath = z.object({name: z.string()});

// Tool input is dynamic (validated per-tool by the tool's own Zod schema inside
// callTool); accept any JSON object here.
const CallBody = z.record(z.string(), z.unknown());

// Permissive manifest schema: tool input/output schemas are arbitrary JSON
// Schema objects, so they are left untyped.
const Manifest = z
  .object({
    server: z.object({name: z.string(), version: z.string()}),
    tools: z.array(
      z.object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        inputSchema: z.any().optional(),
        outputSchema: z.any().optional(),
      }),
    ),
    resources: z.array(
      z.object({
        name: z.string(),
        uri: z.string(),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    ),
    prompts: z.array(
      z.object({name: z.string(), description: z.string().optional()}),
    ),
  })
  .loose();

// ---- Controller (dogfooded REST API over the MCP server) --------------------

/**
 * JSON API the inspector UI consumes, built with the framework's own
 * `@api`/`@get`/`@post` decorators and registered via `app.restController(...)`.
 * Injects the in-process MCP server — no MCP transport is involved.
 */
// Stateless, read-only: request state arrives via method params, never the
// constructor, so one shared instance is safe and avoids a per-request alloc.
@injectable({scope: BindingScope.SINGLETON})
@api({basePath: API_BASE})
export class McpInspectorController {
  constructor(@inject(MCPBindings.SERVER) private readonly mcp: MCPServer) {}

  @get('/manifest', {response: Manifest})
  async manifest(): Promise<z.infer<typeof Manifest>> {
    const tools = this.mcp.listTools().map(t => ({
      name: t.meta.name,
      title: t.meta.title,
      description: t.meta.description,
      ...(t.meta.input
        ? {inputSchema: schemaToOpenApiSchema(t.meta.input)}
        : {}),
      ...(t.meta.output
        ? {outputSchema: schemaToOpenApiSchema(t.meta.output)}
        : {}),
    }));
    const resources = this.mcp.listResources().map(r => ({
      name: r.meta.name,
      uri: r.meta.uri,
      description: r.meta.description,
      mimeType: r.meta.mimeType,
    }));
    const prompts = this.mcp.listPrompts().map(p => ({
      name: p.meta.name,
      description: p.meta.description,
    }));
    return {
      server: {name: this.mcp.config.name, version: this.mcp.config.version},
      tools,
      resources,
      prompts,
    };
  }

  @post('/tools/{name}/call', {
    path: NamePath,
    body: CallBody,
    response: z.any(),
  })
  async call(input: {
    path: z.infer<typeof NamePath>;
    body: z.infer<typeof CallBody>;
  }): Promise<unknown> {
    return this.invoke(() => this.mcp.callTool(input.path.name, input.body));
  }

  @post('/resources/{name}/read', {path: NamePath, response: z.any()})
  async read(input: {path: z.infer<typeof NamePath>}): Promise<unknown> {
    return this.invoke(() => this.mcp.readResource(input.path.name));
  }

  @post('/prompts/{name}/get', {path: NamePath, response: z.any()})
  async getPrompt(input: {path: z.infer<typeof NamePath>}): Promise<unknown> {
    return this.invoke(() => this.mcp.getPrompt(input.path.name));
  }

  /**
   * Run an MCP operation; on failure rethrow as a 400 carrying any Zod issues
   * as `details`, which `RestServer.sendError` serializes as
   * `{error: {statusCode: 400, message, details}}`.
   */
  private async invoke<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const e = err as Error & {statusCode?: number; details?: unknown};
      e.statusCode = 400;
      const issues = (err as {issues?: unknown}).issues;
      if (issues) e.details = issues;
      throw e;
    }
  }
}

// ---- Install / mount --------------------------------------------------------

/**
 * Register {@link McpInspectorController} and mount the React inspector UI on a
 * RestApplication. The controller resolves the MCP server from DI
 * (`MCPBindings.SERVER`), so it must be bound (e.g. via `MCPComponent`). Call
 * BEFORE `app.start()`.
 */
export async function installInspector(
  app: RestApplication,
  options: InspectorOptions = {},
): Promise<void> {
  const opts = {...DEFAULTS, ...options};
  const connect = await installInspectorApi(app, {connect: options.connect});
  const server: RestServer = await app.restServer;
  mountInspector(server, opts, connect);
}

/**
 * Server half of {@link installInspector}: registers {@link
 * McpInspectorController} and, when `connect` is set, mounts mcp-connect — but
 * mounts **no** UI shell. Used by the unified console's MCP feature (which
 * supplies its own shell). Returns the remote-connect shell config (or null).
 */
export async function installInspectorApi(
  app: RestApplication,
  options: {connect?: boolean | McpConnectOptions} = {},
): Promise<ConnectShellConfig | null> {
  if (!app.isBound(MCPBindings.SERVER)) {
    throw new Error(
      '@agentback/mcp-inspector: no MCP server bound at ' +
        `'${MCPBindings.SERVER.key}'. Add MCPComponent and configure the ` +
        'MCP server before installing the inspector.',
    );
  }
  app.restController(McpInspectorController);
  if (!options.connect) return null;
  const copts: McpConnectOptions =
    options.connect === true ? {} : options.connect;
  await installMcpConnect(app, copts);
  const cpath = copts.path ?? DEFAULT_CONNECT_PATH;
  return {base: cpath + '/api', callbackPath: cpath + '/oauth/callback'};
}

/**
 * Server-side contribution for `@agentback/console`: registers the
 * inspector API (and, by default, remote-connect) and advertises the panel's
 * `apiBase` + `connect` config. Paired with the `./console` client page.
 */
export function mcpConsoleFeature(
  options: {connect?: boolean | McpConnectOptions} = {},
) {
  const connectOpt = options.connect ?? true; // remote-connect on by default
  const copts: McpConnectOptions =
    connectOpt === true || connectOpt === false ? {} : connectOpt;
  const cpath = copts.path ?? DEFAULT_CONNECT_PATH;
  const connect: ConnectShellConfig | null = connectOpt
    ? {base: `${cpath}/api`, callbackPath: `${cpath}/oauth/callback`}
    : null;
  return {
    id: 'mcp',
    apiBase: API_BASE,
    css: INSPECTOR_CSS,
    ...(connect ? {extra: {connect}} : {}),
    async install(app: RestApplication): Promise<void> {
      await installInspectorApi(app, {connect: connectOpt});
    },
  };
}

/**
 * Lower-level form: mount the static UI on a RestServer whose context already
 * has {@link McpInspectorController} registered. Pass `connect` to point the UI
 * at an mcp-connect mount you wired up yourself.
 */
export function mountInspector(
  server: RestServer,
  options: InspectorOptions = {},
  connect: ConnectShellConfig | null = null,
): void {
  const opts = {...DEFAULTS, ...options};
  const app = server.expressApp;
  const clientDir = fileURLToPath(new URL('./client/', import.meta.url));

  if (!existsSync(clientDir + 'main.js')) {
    throw new Error(
      '@agentback/mcp-inspector: client bundle not found at ' +
        clientDir +
        'main.js. Run `pnpm build` (or `pnpm -F @agentback/mcp-inspector build:client`) first.',
    );
  }

  app.use(opts.path + '/assets', express.static(clientDir, {index: false}));

  // Server-rendered shell at both <path> and <path>/. No user data is
  // interpolated except the (escaped) title; the React tree renders client-side.
  app.get([opts.path, opts.path + '/'], (_req, res) => {
    res.type('html').send(indexHtml(opts, connect));
  });
}

// ---- Static shell -----------------------------------------------------------

function indexHtml(
  opts: {path: string; title: string},
  connect: ConnectShellConfig | null,
): string {
  const cfg = JSON.stringify({
    apiBase: API_BASE,
    title: opts.title,
    connect,
  }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${THEME_FONTS_HREF.replace(/&/g, '&amp;')}">
  <style>${THEME_CSS}${INSPECTOR_CSS}</style>
</head>
<body>
  <div id="root"></div>
  <script>window.__MCP_INSPECTOR__=${cfg}</script>
  <script type="module" src="${escapeAttr(opts.path)}/assets/main.js"></script>
</body>
</html>`;
}

// Tokens, reset, body/paper-grain, @keyframes rise, button.btn/.ghost and base
// .badge/.empty live in @agentback/console-theme (THEME_CSS), injected
// before this block. Only mcp-inspector-specific rules remain here.
const INSPECTOR_CSS = `
header { padding:.85rem 1.5rem; border-bottom:1px solid var(--line-2); display:flex; align-items:baseline; gap:1rem; flex-wrap:wrap; position:sticky; top:0; z-index:30; background:rgba(243,239,228,.86); backdrop-filter:blur(8px) saturate(1.1); }
header h1 { font-family:var(--serif); font-weight:600; font-size:1.5rem; letter-spacing:-.01em; margin:0; }
header .server { color:var(--muted); font-size:.8rem; font-family:var(--mono); }
header .filter { margin-left:auto; padding:.42rem .65rem; border:1px solid var(--line-2); border-radius:5px; background:var(--card); color:var(--ink); font:inherit; min-width:180px; }
header .filter:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(154,51,36,.12); }
main { padding:1.75rem; max-width:1040px; }
section { margin-bottom:2.25rem; }
section > h2 { font-family:var(--serif); font-weight:500; font-size:1.25rem; letter-spacing:0; color:var(--ink); margin:0 0 .9rem; text-transform:none; }
.section-head { display:flex; align-items:center; gap:.5rem; cursor:pointer; user-select:none; padding-bottom:.4rem; border-bottom:1px solid var(--line); }
.section-head .fold { font-size:.75rem; width:.9em; color:var(--accent); }
.section-head > button.ghost { margin-left:auto; }
.fold { color:var(--accent); }
.card { border:1px solid var(--line-2); border-radius:6px; padding:1.1rem 1.2rem; margin-bottom:1rem; background:var(--card); box-shadow:0 1px 0 rgba(34,29,22,.03), 0 12px 28px -22px rgba(34,29,22,.4); animation:rise .4s cubic-bezier(.2,.7,.3,1) both; }
section .card:nth-child(2){animation-delay:.04s}section .card:nth-child(3){animation-delay:.08s}section .card:nth-child(4){animation-delay:.12s}section .card:nth-child(5){animation-delay:.16s}section .card:nth-child(n+6){animation-delay:.2s}
.card h3 { margin:0 0 .35rem; font-family:var(--mono); font-weight:500; font-size:14px; display:flex; align-items:center; gap:.5rem; color:var(--accent); }
.card-head { cursor:pointer; user-select:none; }
.card-head .head-desc { font-family:var(--sans); font-weight:400; color:var(--muted); font-size:13px; margin-left:.25rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.card .desc { color:var(--muted); margin:0 0 .85rem; font-size:13px; max-width:62ch; }
.field { display:grid; grid-template-columns:150px 1fr; gap:.4rem .85rem; align-items:start; margin-bottom:.6rem; }
.field > label { font-family:var(--mono); font-size:13px; padding-top:.45rem; color:var(--ink); }
.field .req { color:var(--accent); }
.field .hint { color:var(--faint); font-size:11px; margin-top:.25rem; font-family:var(--mono); }
.field .ferr { color:var(--err); font-size:12px; margin-top:.25rem; }
.field input[type=text], .field input[type=number], .field select, .field textarea { width:100%; padding:.45rem .55rem; font-family:var(--mono); font-size:13px; border:1px solid var(--line-2); border-radius:4px; background:var(--paper); color:var(--ink); }
.field input:focus, .field select:focus, .field textarea:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(154,51,36,.12); }
.field textarea { min-height:64px; resize:vertical; }
.banner { color:var(--err); font-size:12px; margin:.5rem 0; font-family:var(--mono); }
.collapse { margin-top:.7rem; }
.collapse summary { cursor:pointer; color:var(--muted); font-size:12px; font-family:var(--mono); }
pre.json { background:var(--paper); border:1px solid var(--line-2); padding:.8rem; border-radius:5px; white-space:pre-wrap; word-break:break-word; font-size:12px; font-family:var(--mono); margin:.6rem 0 0; }
pre.json.err { border-color:var(--err); background:#f7ece6; }
.meta { color:var(--faint); font-size:11px; margin-top:.4rem; font-family:var(--mono); }
.meta .ok { color:var(--ok); font-weight:500; }
.meta .bad { color:var(--err); font-weight:500; }
.history { position:fixed; top:0; right:0; width:380px; max-width:92vw; height:100vh; background:var(--card); border-left:1px solid var(--line-2); box-shadow:-18px 0 40px -24px rgba(34,29,22,.5); padding:1.1rem 1.3rem; overflow:auto; z-index:70; }
.history h2 { font-family:var(--serif); font-weight:600; margin:0 0 .9rem; font-size:1.3rem; }
.history .close { position:absolute; top:.9rem; right:1.1rem; }
.hentry { border:1px solid var(--line); border-radius:5px; padding:.55rem .65rem; margin-bottom:.5rem; background:var(--paper); }
.hentry .top { display:flex; gap:.5rem; align-items:center; font-family:var(--mono); font-size:12px; }
.hentry .name { word-break:break-all; }
.hentry .top .ok { color:var(--ok); font-weight:500; }
.hentry .top .bad { color:var(--err); font-weight:500; }
.hentry time { color:var(--faint); margin-left:auto; font-size:11px; }
.connectbar { display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; position:relative; }
.connect-target { display:flex; align-items:center; gap:.4rem; }
.connect-target .ct-label { font-family:var(--mono); font-size:11px; color:var(--faint); text-transform:uppercase; letter-spacing:.06em; }
.connect-target select { padding:.34rem .5rem; border:1px solid var(--line-2); border-radius:5px; background:var(--card); color:var(--ink); font:inherit; font-size:13px; max-width:240px; }
.connect-target select:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(154,51,36,.12); }
.ct-check { display:flex; align-items:center; gap:.4rem; font-family:var(--mono); font-size:12px; color:var(--muted); padding-top:.45rem; }
.ct-check input { width:auto; }
.add-panel { position:absolute; top:calc(100% + .55rem); left:0; z-index:40; width:min(420px,90vw); background:var(--card); border:1px solid var(--line-2); border-radius:7px; padding:1.05rem 1.15rem; box-shadow:0 18px 44px -22px rgba(34,29,22,.55); animation:rise .25s cubic-bezier(.2,.7,.3,1) both; }
.add-panel .field { grid-template-columns:84px 1fr; margin-bottom:.7rem; }
.add-panel .field > label { padding-top:.5rem; font-size:12px; }
.add-panel .btn { margin-top:.3rem; }
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
