// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import express, {type Express, type Request, type Response} from 'express';
import type {RestApplication} from '@agentback/rest';
import type {Installed} from '@agentback/core';
import {RemoteRegistry, type AuthConfig} from './registry.js';

export * from './registry.js';

export interface McpConnectOptions {
  /** Base path the connection API + OAuth callback are mounted at. Default
   * `/mcp-connect`. The JSON API lives under `<path>/api`. */
  path?: string;
  /** Reuse an existing registry (otherwise a fresh one is created). */
  registry?: RemoteRegistry;
  /**
   * Allow targets on loopback / private / reserved addresses. Default `false`
   * (SSRF mitigation — see {@link RemoteRegistryOptions}). Set `true` for
   * trusted deployments or local development against `localhost` servers.
   * Ignored when `registry` is supplied (configure it on the registry instead).
   */
  allowPrivateTargets?: boolean;
}

const DEFAULT_PATH = '/mcp-connect';

/**
 * Mount a remote-MCP **connection manager** on a RestApplication: a JSON API to
 * add/list/remove remote MCP server targets (no-auth, bearer, or interactive
 * OAuth), proxy their tools/resources/prompts, plus the OAuth redirect callback.
 * UIs (e.g. `@agentback/mcp-inspector`) consume these endpoints; this
 * package owns the connection + OAuth machinery so the UI stays thin.
 *
 * @returns the {@link RemoteRegistry} backing the mount, extended with the
 * revertible-install `uninstall()`. Caveat: the method is attached to the
 * registry object itself, so passing the SAME caller-provided registry to two
 * installs leaves only the second mount's uninstall — give each mount its own
 * registry (or omit `options.registry`) if you need per-mount retraction.
 */
export async function installMcpConnect(
  app: RestApplication,
  options: McpConnectOptions = {},
): Promise<RemoteRegistry & Installed> {
  const createdHere = !options.registry;
  const registry =
    options.registry ??
    new RemoteRegistry({allowPrivateTargets: options.allowPrivateTargets});
  const server = await app.restServer;
  const mounted = mountMcpConnect(server.expressApp, registry, options);
  let uninstalled = false;
  return Object.assign(registry, {
    uninstall: async () => {
      if (uninstalled) return;
      uninstalled = true;
      await mounted.uninstall();
      // Close live upstream connections only when this install owns the
      // registry; a caller-provided registry keeps its own lifecycle.
      if (createdHere) await registry.closeAll();
    },
  });
}

export function mountMcpConnect(
  expressApp: Express,
  registry: RemoteRegistry,
  options: McpConnectOptions = {},
): Installed {
  const path = options.path ?? DEFAULT_PATH;
  const api = `${path}/api`;
  const json = express.json();
  // Express cannot unmount a layer; every registration below shares one gate
  // (revertible-installs.md, option 1).
  let live = true;
  const gate = (_req: Request, _res: Response, next: (e?: unknown) => void) =>
    live ? next() : next('route');

  const fail = (res: Response, status: number, message: string) =>
    res.status(status).json({error: {message}});

  const requireSource = (req: Request, res: Response) => {
    const source = registry.source(req.params.id as string);
    if (!source)
      fail(res, 404, `Unknown or unconnected target: ${req.params.id}`);
    return source;
  };

  // ---- target lifecycle ----
  expressApp.get(`${api}/targets`, gate, (_req, res) =>
    res.json(registry.list()),
  );

  expressApp.post(
    `${api}/targets`,
    gate,
    json,
    async (req: Request, res: Response) => {
      const {url, auth} = (req.body ?? {}) as {url?: string; auth?: AuthConfig};
      if (!url) return fail(res, 400, 'Missing "url"');
      const redirectUri = `${req.protocol}://${req.get('host')}${path}/oauth/callback`;
      try {
        res.json(
          await registry.addTarget(url, auth ?? {type: 'none'}, redirectUri),
        );
      } catch (err) {
        fail(res, 400, (err as Error).message);
      }
    },
  );

  expressApp.delete(`${api}/targets/:id`, gate, async (req, res) => {
    await registry.remove(req.params.id as string);
    res.status(204).end();
  });

  // ---- proxied inspection / invocation ----
  expressApp.get(`${api}/targets/:id/manifest`, gate, async (req, res) => {
    const source = requireSource(req, res);
    if (!source) return;
    try {
      res.json(await source.manifest());
    } catch (err) {
      fail(res, 502, (err as Error).message);
    }
  });

  expressApp.post(
    `${api}/targets/:id/tools/:name/call`,
    gate,
    json,
    async (req, res) => {
      const source = requireSource(req, res);
      if (!source) return;
      try {
        res.json(
          await source.callTool(
            req.params.name as string,
            (req.body ?? {}) as Record<string, unknown>,
          ),
        );
      } catch (err) {
        fail(res, 400, (err as Error).message);
      }
    },
  );

  expressApp.post(
    `${api}/targets/:id/resources/read`,
    gate,
    json,
    async (req, res) => {
      const source = requireSource(req, res);
      if (!source) return;
      const {uri} = (req.body ?? {}) as {uri?: string};
      if (!uri) return fail(res, 400, 'Missing "uri"');
      try {
        res.json(await source.readResource(uri));
      } catch (err) {
        fail(res, 400, (err as Error).message);
      }
    },
  );

  expressApp.post(
    `${api}/targets/:id/prompts/:name/get`,
    gate,
    async (req, res) => {
      const source = requireSource(req, res);
      if (!source) return;
      try {
        res.json(await source.getPrompt(req.params.name as string));
      } catch (err) {
        fail(res, 400, (err as Error).message);
      }
    },
  );

  // ---- OAuth redirect callback ----
  expressApp.get(`${path}/oauth/callback`, gate, async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    let ok = false;
    let message = '';
    if (!code || !state) {
      message = 'Missing code or state';
    } else {
      try {
        await registry.completeOAuth(state, code);
        ok = true;
      } catch (err) {
        message = (err as Error).message;
      }
    }
    res.type('html').send(callbackHtml(ok, message));
  });
  return {
    uninstall: async () => {
      live = false;
    },
  };
}

/** A tiny page that signals the opener window and closes the popup. */
function callbackHtml(ok: boolean, message: string): string {
  const payload = JSON.stringify({
    source: 'mcp-connect',
    type: 'oauth-complete',
    ok,
  }).replace(/</g, '\\u003c');
  const text = ok
    ? 'Authorized — you can close this window.'
    : `Authorization failed: ${message}`;
  // Post to our OWN origin only (this page is served same-origin as the
  // inspector that opened it), not '*', so the result isn't readable by an
  // unrelated opener; the listener likewise checks event.origin.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>MCP OAuth</title></head><body style="font:14px system-ui;padding:2rem">
<p>${escapeHtml(text)}</p>
<script>try{window.opener&&window.opener.postMessage(${payload},window.location.origin)}catch(e){}setTimeout(function(){window.close()},300)</script>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
        c
      ]!,
  );
}
