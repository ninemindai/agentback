// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import express from 'express';
import swaggerUI from 'swagger-ui-dist';
import {RestApplication, RestServer, serveStaticDir} from '@agentback/rest';

export interface ExplorerOptions {
  /** URL path where the explorer is mounted. Default `/explorer`. */
  path?: string;
  /** URL of the OpenAPI document to load. Default `/openapi.json`. */
  specUrl?: string;
  /** Page title for the explorer. Default `API Explorer`. */
  title?: string;
}

const DEFAULTS: Required<ExplorerOptions> = {
  path: '/explorer',
  specUrl: '/openapi.json',
  title: 'API Explorer',
};

/**
 * Mount Swagger UI 5.x at `options.path` against the REST server's OpenAPI
 * 3.1 document. Call this AFTER constructing the RestApplication and
 * registering controllers, but BEFORE `app.start()`.
 *
 * @example
 *   const app = new RestApplication();
 *   app.restController(GreetingController);
 *   await installExplorer(app);
 *   await app.start();
 *   // -> Swagger UI at http://host:port/explorer/
 */
export async function installExplorer(
  app: RestApplication,
  options: ExplorerOptions = {},
): Promise<void> {
  const opts = {...DEFAULTS, ...options};
  const server: RestServer = await app.restServer;
  mountExplorer(server, opts);
}

/**
 * Lower-level form: mount directly on a RestServer instance. Useful when
 * you've resolved the server separately or are not using RestApplication.
 */
export function mountExplorer(
  server: RestServer,
  options: ExplorerOptions = {},
): void {
  const opts = {...DEFAULTS, ...options};
  const app = server.expressApp;
  const fsPath = swaggerUI.getAbsoluteFSPath();
  const html = indexHtml(opts);

  // Express path (Node/Express hosts) — unchanged.
  // Order matters: register the index override BEFORE express.static, and
  // disable static's default index so it doesn't serve swagger-ui-dist's
  // bundled index.html (which points at the Petstore demo).
  app.get(opts.path + '/', (_req, res) => {
    res.type('html').send(html);
  });
  app.get(opts.path, (_req, res) => {
    res.redirect(301, opts.path + '/');
  });
  app.use(opts.path, express.static(fsPath, {index: false}));

  // Neutral fetch path (Bun/Deno/Fastify hosts via fetchHandler()).
  // The HTML shell and redirect are exact handlers (highest priority), then the
  // prefix handler serves static assets from the swagger-ui-dist directory.
  const serveAsset = serveStaticDir(fsPath);
  server.addFetchHandler(
    'GET',
    opts.path + '/',
    async () => new Response(html, {headers: {'content-type': 'text/html; charset=utf-8'}}),
  );
  server.addFetchHandler(
    'GET',
    opts.path,
    async req =>
      Response.redirect(new URL(opts.path + '/', req.url).toString(), 301),
  );
  server.addFetchPrefix(opts.path, suffix => serveAsset(suffix));
}

/**
 * Server-side contribution for `@agentback/console`: mounts Swagger UI
 * (and serves it at `path`) and advertises the iframe URL for the panel. Paired
 * with the `./console` client page, which embeds `extra.url` in an iframe.
 */
export function apiConsoleFeature(options: ExplorerOptions = {}) {
  const opts = {...DEFAULTS, ...options};
  return {
    id: 'api',
    apiBase: opts.path,
    extra: {url: opts.path + '/'},
    async install(app: RestApplication): Promise<void> {
      await installExplorer(app, options);
    },
  };
}

function indexHtml(opts: Required<ExplorerOptions>): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(opts.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&amp;family=Hanken+Grotesk:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap">
  <link rel="stylesheet" href="${escapeAttr(opts.path)}/swagger-ui.css">
  <link rel="icon" href="${escapeAttr(opts.path)}/favicon-32x32.png">
  <style>${SWAGGER_THEME}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="${escapeAttr(opts.path)}/swagger-ui-bundle.js"></script>
  <script src="${escapeAttr(opts.path)}/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: ${JSON.stringify(opts.specUrl)},
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      tryItOutEnabled: true,
    });
  </script>
</body>
</html>`;
}

// "Blueprint paper" theme layered over swagger-ui's stylesheet: warm paper
// background with a faint grid + grain, Fraunces serif headings, JetBrains Mono
// for paths/code, and an oxblood accent — matching the context-explorer and
// mcp-inspector UIs. HTTP method colors are intentionally preserved.
const SWAGGER_THEME = `
:root {
  --paper:#f3efe4; --card:#fcfaf3; --ink:#221d16; --muted:#6f6555; --line:#ddd3c0; --line-2:#cabfa6; --accent:#9a3324;
  --serif:'Fraunces',Georgia,serif; --sans:'Hanken Grotesk',system-ui,sans-serif; --mono:'JetBrains Mono',ui-monospace,monospace;
}
html,body { margin:0; }
body {
  background-color:var(--paper);
  background-image:
    linear-gradient(rgba(34,29,22,.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(34,29,22,.045) 1px, transparent 1px);
  background-size:27px 27px;
}
body::after {
  content:''; position:fixed; inset:0; pointer-events:none; z-index:9999; opacity:.14; mix-blend-mode:multiply;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.6'/%3E%3C/svg%3E");
}
.swagger-ui { font-family:var(--sans); color:var(--ink); }
.swagger-ui .info .title,
.swagger-ui .opblock-tag,
.swagger-ui h1, .swagger-ui h2, .swagger-ui h3, .swagger-ui h4, .swagger-ui h5 {
  font-family:var(--serif); color:var(--ink); font-weight:600;
}
.swagger-ui .opblock-tag { font-weight:500; border-bottom:1px solid var(--line); }
.swagger-ui .info { margin:28px 0 20px; }
.swagger-ui .topbar { background:var(--ink); padding:12px 0; border-bottom:2px solid var(--accent); }
.swagger-ui .topbar .download-url-wrapper .download-url-button { background:var(--accent); color:#fdf8ef; border:0; font-family:var(--sans); }
.swagger-ui .topbar .download-url-wrapper input[type=text] { border-color:var(--line-2); font-family:var(--mono); }
.swagger-ui .scheme-container { background:var(--card); box-shadow:none; border-bottom:1px solid var(--line-2); }
.swagger-ui .opblock { background:var(--card); border:1px solid var(--line-2); border-radius:6px; box-shadow:0 12px 28px -22px rgba(34,29,22,.4); margin:0 0 14px; }
.swagger-ui .opblock.opblock-get, .swagger-ui .opblock.opblock-post,
.swagger-ui .opblock.opblock-put, .swagger-ui .opblock.opblock-delete,
.swagger-ui .opblock.opblock-patch { background:var(--card); }
.swagger-ui .opblock .opblock-summary { border-color:var(--line); }
.swagger-ui .opblock .opblock-summary-path,
.swagger-ui .opblock .opblock-summary-path__deprecated { font-family:var(--mono); color:var(--ink); }
.swagger-ui .opblock .opblock-summary-method { font-family:var(--mono); border-radius:4px; }
.swagger-ui .renderedMarkdown code, .swagger-ui .microlight,
.swagger-ui textarea, .swagger-ui input[type=text],
.swagger-ui .model, .swagger-ui .prop-type { font-family:var(--mono) !important; }
.swagger-ui select, .swagger-ui input[type=text], .swagger-ui textarea { border-color:var(--line-2); background:var(--paper); color:var(--ink); }
.swagger-ui .btn { border-radius:5px; font-family:var(--sans); }
.swagger-ui .btn.execute { background:var(--accent); border-color:var(--accent); color:#fdf8ef; }
.swagger-ui .btn.execute:hover { background:#812519; }
.swagger-ui .btn.authorize { color:var(--accent); border-color:var(--accent); }
.swagger-ui .btn.authorize svg { fill:var(--accent); }
.swagger-ui .tab li { font-family:var(--mono); }
.swagger-ui .info a, .swagger-ui a.nostyle { color:var(--accent); }
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
