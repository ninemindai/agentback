// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import express, {type Express, type Request, type Response} from 'express';
import type {RestApplication} from '@agentback/rest';
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
 * @returns the {@link RemoteRegistry} backing the mount.
 */
export async function installMcpConnect(
  app: RestApplication,
  options: McpConnectOptions = {},
): Promise<RemoteRegistry> {
  const registry =
    options.registry ??
    new RemoteRegistry({allowPrivateTargets: options.allowPrivateTargets});
  const server = await app.restServer;
  mountMcpConnect(server.expressApp, registry, options);
  return registry;
}

export function mountMcpConnect(
  expressApp: Express,
  registry: RemoteRegistry,
  options: McpConnectOptions = {},
): void {
  const path = options.path ?? DEFAULT_PATH;
  const api = `${path}/api`;
  const json = express.json();

  const fail = (res: Response, status: number, message: string) =>
    res.status(status).json({error: {message}});

  const requireSource = (req: Request, res: Response) => {
    const source = registry.source(req.params.id as string);
    if (!source)
      fail(res, 404, `Unknown or unconnected target: ${req.params.id}`);
    return source;
  };

  // ---- target lifecycle ----
  expressApp.get(`${api}/targets`, (_req, res) => res.json(registry.list()));

  expressApp.post(
    `${api}/targets`,
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

  expressApp.delete(`${api}/targets/:id`, async (req, res) => {
    await registry.remove(req.params.id!);
    res.status(204).end();
  });

  // ---- proxied inspection / invocation ----
  expressApp.get(`${api}/targets/:id/manifest`, async (req, res) => {
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
    json,
    async (req, res) => {
      const source = requireSource(req, res);
      if (!source) return;
      try {
        res.json(
          await source.callTool(
            req.params.name!,
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

  expressApp.post(`${api}/targets/:id/prompts/:name/get`, async (req, res) => {
    const source = requireSource(req, res);
    if (!source) return;
    try {
      res.json(await source.getPrompt(req.params.name!));
    } catch (err) {
      fail(res, 400, (err as Error).message);
    }
  });

  // ---- OAuth redirect callback ----
  expressApp.get(`${path}/oauth/callback`, async (req, res) => {
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
