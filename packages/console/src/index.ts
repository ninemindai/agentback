// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import express, {type RequestHandler} from 'express';
import {THEME_CSS, THEME_FONTS_HREF} from '@agentback/console-theme';
import {contextConsoleFeature} from '@agentback/context-explorer';
import {apiConsoleFeature} from '@agentback/rest-explorer';
import {mcpConsoleFeature} from '@agentback/mcp-inspector';
import {schemaConsoleFeature} from '@agentback/schema-explorer';
import type {Installed} from '@agentback/core';
import {composeTeardown, installSteps} from '@agentback/common';
import type {RestApplication, RestServer} from '@agentback/rest';
import {AssetSource, fromDisk, installGate} from '@agentback/rest';
import {liveHandler} from './live.js';

/**
 * A server-side panel contribution: registers the panel's JSON API (no
 * standalone shell) and advertises where the client panel should reach it.
 * Authored by each tool (e.g. `contextConsoleFeature()`); `installConsole`
 * installs the list and injects `apiBase`/`extra` into the shell so the
 * matching {@link ConsolePage} (by `id`) can render.
 */
export interface ConsoleFeature {
  id: string;
  /** Base path of this panel's API, e.g. `/context-explorer/api`. */
  apiBase: string;
  /** Per-panel config forwarded to the client panel (inspector connect, …). */
  extra?: Record<string, unknown>;
  /** Panel-specific CSS, injected once into the shell after the shared theme. */
  css?: string;
  /**
   * Register the feature's server half. Returning an {@link Installed}
   * (duck-typed: any object with `uninstall()`) lets `installConsole`
   * compose the feature's teardown into its own; `void` still works.
   */
  install(app: RestApplication): Promise<void | Installed> | void | Installed;
}

/**
 * Chat dock config forwarded to `window.__CONSOLE__.chat`.
 * Populated by {@link installConsole} from the `chatConsoleFeature()` in
 * `features` — callers do not set this directly; it is extracted automatically.
 */
export interface ConsoleChatConfig {
  enabled: boolean;
  apiBase: string;
  agents: {id: string; name: string}[];
}

export interface ConsoleOptions {
  /** Base path the console UI is mounted at. Default `/console`. */
  basePath?: string;
  /** Console title (shown in the sidebar). Default `AgentBack console`. */
  title?: string;
  /** Panels to compose. Default: context-explorer, rest-explorer, mcp-inspector. */
  features?: ConsoleFeature[];
  /**
   * Optional auth middleware. When set, it gates the console UI **and** the
   * aggregated panel APIs (each feature's `apiBase`, plus any mcp-connect base).
   * The server is the authority; the client only hides nav.
   */
  auth?: RequestHandler | RequestHandler[];
  /**
   * Override the static asset source. Defaults to reading from the package's
   * bundled `client/` directory on disk (`fromDisk`). Pass a custom
   * {@link AssetSource} to serve from a CDN or edge KV store.
   */
  assets?: AssetSource;
  /**
   * Explicitly allow mounting the console without server-side auth.
   * Unsafe outside local development.
   */
  unsafeAllowUnauthenticated?: boolean;
}

const DEFAULT_BASE = '/console';

/** The built-in panels, in nav order. */
export function defaultFeatures(): ConsoleFeature[] {
  return [
    contextConsoleFeature(),
    schemaConsoleFeature(),
    apiConsoleFeature(),
    mcpConsoleFeature(),
  ];
}

/**
 * Mount the unified developer console on a RestApplication: a single SPA at
 * `basePath` composing each {@link ConsoleFeature}'s panel, with shared chrome
 * + theme. Registers each feature's API. Call BEFORE `app.start()`.
 */
export async function installConsole(
  app: RestApplication,
  options: ConsoleOptions = {},
): Promise<{basePath: string; features: ConsoleFeature[]} & Installed> {
  const basePath = options.basePath ?? DEFAULT_BASE;
  const title = options.title ?? 'AgentBack console';
  const features = options.features ?? defaultFeatures();
  const server: RestServer = await app.restServer;

  if (!options.auth && options.unsafeAllowUnauthenticated !== true) {
    throw new Error(
      '@agentback/console requires an explicit auth posture: provide `auth`, or pass `unsafeAllowUnauthenticated: true` for local development.',
    );
  }

  // Each step hands over its inverse before the next one runs, so a throw
  // anywhere below reverts what already landed and rethrows — no rollback
  // `catch` per early exit, and no region left uncovered by one
  // (revertible-installs.md, composition rule).
  const {value, teardown} = await installSteps(async function* () {
    // Gate BEFORE features register their routes, so the auth middleware sits
    // ahead of them in the Express stack. Covers the UI, each panel API, and
    // any remote-connect base advertised via a feature's `extra.connect`.
    if (options.auth) {
      const handlers = Array.isArray(options.auth)
        ? options.auth
        : [options.auth];
      const prefixes = new Set<string>([basePath]);
      for (const f of features) {
        prefixes.add(f.apiBase);
        const connect = (f.extra as {connect?: {base?: string}} | undefined)
          ?.connect;
        if (connect?.base) prefixes.add(connect.base);
      }
      // Express cannot unmount; each auth layer is individually gated so
      // uninstall turns it into a pass-through (revertible-installs.md).
      const authGate = installGate();
      yield () => authGate.off();
      for (const prefix of prefixes) {
        for (const h of handlers) {
          server.expressApp.use(prefix, authGate.wrap(h));
        }
      }
    }

    // A feature that throws (e.g. mcpConsoleFeature on an app with no MCP
    // server bound) must not leave the already-installed features' footprint
    // behind.
    for (const feature of features) {
      const r = await feature.install(app);
      if (r && typeof (r as Installed).uninstall === 'function') {
        yield () => (r as Installed).uninstall();
      }
    }

    // Extract chat config from the chat feature, if present. We use
    // duck-typing to avoid a static import of @agentback/console-chat (which
    // depends on @agentback/console — importing it here would be a circular
    // dep).
    const chatFeature = features.find(
      (f): f is ConsoleFeature & {chatConfig: ConsoleChatConfig} =>
        'chatConfig' in f,
    );

    const mounted = mountConsole(server, {
      basePath,
      title,
      features,
      assets: options.assets,
      chat: chatFeature?.chatConfig,
    });
    yield () => mounted.uninstall();

    return {basePath, features};
  });
  return {...value, uninstall: () => teardown.run()};
}

/**
 * Lower-level form: serve the console shell on a RestServer whose features are
 * already installed. (Auth gating is handled by {@link installConsole}.)
 */
export function mountConsole(
  server: RestServer,
  options: {
    basePath: string;
    title: string;
    features: ConsoleFeature[];
    assets?: AssetSource;
    /** When the chat dock is enabled, inject its config into window.__CONSOLE__. */
    chat?: ConsoleChatConfig;
  },
): Installed {
  const {basePath, title, features} = options;
  const app = server.expressApp;
  // Live-reflection channel: a per-process boot id over SSE. The client's
  // liveBus refetches the explorer panels when a reconnect returns a NEW boot
  // id (i.e. the app restarted). Mounted on expressApp like the chat stream so
  // RestServer.sendResult never ends it. Under basePath → covered by the auth
  // gate installed in installConsole.
  // Express cannot unmount; the shell's layers share one gate
  // (revertible-installs.md, option 1).
  const td = composeTeardown();
  const g = installGate();
  td.push(() => g.off());
  app.get(basePath + '/live', g.gate, (req, res) => liveHandler(req, res));
  const clientDir = fileURLToPath(new URL('./client/', import.meta.url));

  if (!existsSync(clientDir + 'main.js')) {
    throw new Error(
      '@agentback/console: client bundle not found at ' +
        clientDir +
        'main.js. Run `pnpm build` (or `pnpm -F @agentback/console build:client`) first.',
    );
  }

  app.use(
    basePath + '/assets',
    g.wrap(express.static(clientDir, {index: false})),
  );
  const hasCss = existsSync(clientDir + 'main.css');
  const html = indexHtml(basePath, title, features, hasCss, options.chat);
  app.get([basePath, basePath + '/'], g.gate, (_req, res) => {
    res.type('html').send(html);
  });

  // Neutral fetch path (Bun/Deno/Fastify hosts via fetchHandler()).
  const serveAsset = options.assets ?? fromDisk(clientDir);
  const htmlResponse = async () =>
    new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}});
  td.push(server.addFetchHandler('GET', basePath, htmlResponse));
  td.push(server.addFetchHandler('GET', basePath + '/', htmlResponse));
  td.push(
    server.addFetchPrefix(basePath + '/assets', suffix => serveAsset(suffix)),
  );
  return {uninstall: () => td.run()};
}

// ---- Static shell -----------------------------------------------------------

function indexHtml(
  basePath: string,
  title: string,
  features: ConsoleFeature[],
  hasCss: boolean,
  chat?: ConsoleChatConfig,
): string {
  const panels = Object.fromEntries(
    features.map(f => [
      f.id,
      {apiBase: f.apiBase, ...(f.extra ? {extra: f.extra} : {})},
    ]),
  );
  const cfgObj: Record<string, unknown> = {basePath, title, panels};
  if (chat) cfgObj['chat'] = chat;
  const cfg = JSON.stringify(cfgObj).replace(/</g, '\\u003c');
  const cssLink = hasCss
    ? `<link rel="stylesheet" href="${escapeAttr(basePath)}/assets/main.css">`
    : '';
  const panelCss = features.map(f => f.css ?? '').join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${THEME_FONTS_HREF.replace(/&/g, '&amp;')}">
  ${cssLink}
  <style>${THEME_CSS}${panelCss}${CONSOLE_CSS}</style>
</head>
<body>
  <div id="root"></div>
  <script>window.__CONSOLE__=${cfg}</script>
  <script type="module" src="${escapeAttr(basePath)}/assets/main.js"></script>
</body>
</html>`;
}

const CONSOLE_CSS = `
.console { display:grid; grid-template-columns:208px 1fr; height:100vh; }
.sidebar { border-right:1px solid var(--line-2); background:var(--card); padding:1rem .75rem; overflow:auto; }
.sidebar .brand { font-family:var(--serif); font-weight:600; font-size:1.15rem; letter-spacing:-.01em; margin:0 0 1rem; padding:0 .4rem; }
.sidebar nav { display:flex; flex-direction:column; gap:.12rem; }
.sidebar nav a { display:flex; align-items:center; gap:.55rem; padding:.45rem .6rem; border-radius:5px; color:var(--ink); text-decoration:none; font-size:14px; }
.sidebar nav a:hover { background:var(--paper); }
.sidebar nav a.active { background:var(--paper); box-shadow:inset 3px 0 0 var(--accent); color:var(--accent); }
.sidebar nav a .icon { color:var(--accent); width:1.1em; text-align:center; font-size:.95em; }
.panel { position:relative; height:100vh; overflow:auto; }
.live-offline { font-size:11px; color:var(--accent); margin:0 0 .75rem; padding:0 .4rem; letter-spacing:.02em; }
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
