// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Revertible-install conformance for installConsole
 * (docs/proposals/revertible-installs.md, wave 4): uninstall() retracts the
 * console shell AND every composed feature's footprint — the composition
 * test of the contract, since installConsole is a helper made of helpers.
 */

import {z} from 'zod';
import {describe, expect, it} from 'vitest';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {runInstallConformance} from '@agentback/testing';
import {installConsole} from '../../index.js';

const EchoInput = z.object({text: z.string().min(1)});

@mcpServer()
class EchoTools {
  @tool('echo', {description: 'echo back', input: EchoInput})
  echo(input: z.infer<typeof EchoInput>) {
    return {echoed: input.text};
  }
}

runInstallConformance('installConsole', {
  makeApp: async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'console-uninstall-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(EchoTools);
    await app.get<MCPServer>('servers.MCPServer');
    return app;
  },
  install: app => installConsole(app, {unsafeAllowUnauthenticated: true}),
  served: [
    '/console',
    '/console/',
    '/console/assets/main.js',
    // Feature APIs — each composed feature's footprint must retract too.
    '/context-explorer/api/model',
    '/schema-explorer/api/schemas',
    '/explorer/',
    '/mcp-inspector/api/manifest',
  ],
  untouched: ['/openapi.json'],
});

describe('installConsole failure cleanup and auth gating', () => {
  it('a feature that throws mid-install retracts the already-installed features', async () => {
    // No MCPComponent: mcpConsoleFeature throws AFTER context/schema/api
    // features installed — the partial footprint must be cleaned up
    // (revertible-installs.md, composition rule).
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});

    await expect(
      installConsole(app, {unsafeAllowUnauthenticated: true}),
    ).rejects.toThrow(/no MCP server bound/);

    expect(app.isBound('controllers.ContextExplorerController')).toBe(false);
    expect(app.isBound('controllers.SchemaExplorerController')).toBe(false);
    // The explorer feature mounted fetch handlers before the throw — they
    // must be retracted (probe without starting the server).
    const server = await app.restServer;
    const res = await server
      .fetchHandler()
      .fetch(new Request('http://cleanup/explorer/'));
    expect(res.status).toBe(404);
    await app.stop();
  });

  it('auth layers gate the console while installed and pass through after uninstall', async () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'console-auth-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(EchoTools);
    await app.get<MCPServer>('servers.MCPServer');

    const auth: import('express').RequestHandler = (req, res, next) => {
      if (req.headers['x-console-key'] === 'letmein') return next();
      res.status(401).json({error: {code: 'unauthorized'}});
    };
    const installed = await installConsole(app, {auth});
    await app.start();
    const server = await app.restServer;
    try {
      // Enforced while installed: no key → 401, key → 200.
      const denied = await fetch(`${server.url}/console/`);
      expect(denied.status).toBe(401);
      const allowed = await fetch(`${server.url}/console/`, {
        headers: {'x-console-key': 'letmein'},
      });
      expect(allowed.status).toBe(200);
      const apiDenied = await fetch(`${server.url}/context-explorer/api/model`);
      expect(apiDenied.status).toBe(401);

      await installed.uninstall();

      // After uninstall the auth layers pass through — safe only because the
      // panel routes are gated off in the same teardown. Assert both halves.
      for (const path of ['/console/', '/context-explorer/api/model']) {
        const res = await fetch(`${server.url}${path}`);
        expect(res.status, `${path} after uninstall`).toBe(404);
      }
    } finally {
      await app.stop();
    }
  });
});
