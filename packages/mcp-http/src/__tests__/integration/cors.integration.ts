// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp} from '../../index.js';

// A browser MCP client's traffic to `/mcp` is ALWAYS preflighted: every one of
// `content-type: application/json`, `MCP-Protocol-Version`, `Mcp-Session-Id`
// and `Authorization` is a non-simple header. So `/mcp` is reachable from a
// browser only when the app configures `rest.cors` — and `curl` is unaffected,
// which is what makes this hard to diagnose: the endpoint works perfectly from
// a terminal and is unreachable from a page.
//
// `/mcp` is deliberately NOT open-CORS the way the discovery document is: the
// discovery metadata is unauthenticated and public, `/mcp` is the authenticated
// surface. Who may call it stays the app's decision.

const EchoIn = z.object({text: z.string().min(1)});

@mcpServer()
class DemoTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }
}

const ORIGIN = 'https://app.example.test';

/** The exact preflight a browser sends before an MCP POST. */
const preflight = (url: URL) =>
  fetch(url, {
    method: 'OPTIONS',
    headers: {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers':
        'content-type,mcp-protocol-version,mcp-session-id',
    },
  });

const initialize = (url: URL) =>
  fetch(url, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {name: 'browser', version: '0'},
      },
    }),
  });

describe.each(['express', 'native'] as const)(
  'browser CORS for /mcp (%s host)',
  listener => {
    let app: RestApplication;
    let mcpUrl: URL;

    // Structural, not `import type {CorsOptions} from 'cors'`: `cors` is an
    // optional peer of @agentback/rest and is not a dependency here.
    async function start(opts: {
      protocol?: 'legacy' | 'both';
      cors?: true | {origin?: string; exposedHeaders?: string[]};
    }) {
      app = new RestApplication({rest: {listener}});
      app.configure('servers.RestServer').to({
        port: 0,
        host: '127.0.0.1',
        listener,
        ...(opts.cors ? {cors: opts.cors} : {}),
      });
      app.component(MCPComponent);
      app.configure('servers.MCPServer').to({
        name: 'cors',
        version: '0.0.0',
        transports: {stdio: false},
      });
      app.service(DemoTools);
      await app.get<MCPServer>('servers.MCPServer');
      await installMcpHttp(app, {
        ...(opts.protocol ? {protocol: opts.protocol} : {}),
      });
      await app.start();
      mcpUrl = new URL(
        (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
      );
    }

    afterEach(async () => app?.stop());

    it('is unreachable from a browser when `rest.cors` is unset', async () => {
      // Not a bug — an explicit default. Pinned because it is the single most
      // likely support question: working curl, broken browser, no error that
      // says "CORS". The fix is `rest: {cors: true}`, not a change here.
      await start({});
      const res = await preflight(mcpUrl);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      await res.body?.cancel();
    });

    it('answers the preflight once `rest.cors` is configured', async () => {
      await start({cors: true});
      const res = await preflight(mcpUrl);
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toMatch(
        /^\*$|app\.example\.test/,
      );
      // The MCP-specific headers must survive: without these the browser
      // refuses to send the request it just asked permission for.
      const allowed = (
        res.headers.get('access-control-allow-headers') ?? ''
      ).toLowerCase();
      expect(allowed).toContain('mcp-protocol-version');
      expect(allowed).toContain('mcp-session-id');
      await res.body?.cancel();
    });

    it('exposes Mcp-Session-Id so a browser can read the minted session', async () => {
      // The subtle half. A preflight that passes is not enough: under CORS a
      // response header is invisible to JS unless it is named in
      // Access-Control-Expose-Headers. Without this the browser client
      // completes `initialize`, cannot see the id, echoes nothing back, and is
      // answered "no active MCP session" on its very next call.
      await start({protocol: 'legacy', cors: true});
      const res = await initialize(mcpUrl);
      expect(res.headers.get('mcp-session-id')).toBeTypeOf('string');
      expect(
        (res.headers.get('access-control-expose-headers') ?? '').toLowerCase(),
      ).toContain('mcp-session-id');
      await res.body?.cancel();
    });

    it("exposes nothing extra under protocol: 'both' — there is no session", async () => {
      await start({protocol: 'both', cors: true});
      const res = await initialize(mcpUrl);
      expect(res.headers.get('mcp-session-id')).toBeNull();
      expect(res.headers.get('access-control-expose-headers')).toBeNull();
      await res.body?.cancel();
    });

    it("preserves an app's own exposedHeaders", async () => {
      // An app that exposes its own headers must not lose them to ours.
      await start({
        protocol: 'legacy',
        cors: {origin: ORIGIN, exposedHeaders: ['X-Request-Id']},
      });
      const res = await initialize(mcpUrl);
      const exposed = (
        res.headers.get('access-control-expose-headers') ?? ''
      ).toLowerCase();
      expect(exposed).toContain('x-request-id');
      expect(exposed).toContain('mcp-session-id');
      await res.body?.cancel();
    });
  },
);
