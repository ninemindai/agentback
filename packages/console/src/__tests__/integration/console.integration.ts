// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import type {RequestHandler} from 'express';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installConsole} from '../../index.js';

const AddIn = z.object({a: z.number().int(), b: z.number().int()});

@mcpServer()
class Tools {
  @tool('add', {input: AddIn})
  add(input: z.infer<typeof AddIn>) {
    return {sum: input.a + input.b};
  }
}

async function makeApp(auth?: RequestHandler) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'console-test',
    version: '1.0.0',
    transports: {stdio: false},
  });
  app.service(Tools);
  await app.get<MCPServer>('servers.MCPServer');
  await installConsole(app, {
    title: 'Test Console',
    ...(auth ? {auth} : {unsafeAllowUnauthenticated: true}),
  });
  await app.start();
  return app;
}

describe('mcp/rest/context unified console', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = await makeApp();
    client = supertest((await app.restServer).url);
  });
  afterEach(async () => app.stop());

  describe('shell', () => {
    it('serves the console HTML at /console and /console/', async () => {
      for (const path of ['/console', '/console/']) {
        const r = await client.get(path).expect(200);
        expect(r.headers['content-type']).toMatch(/text\/html/);
        expect(r.text).toMatch(/<title>Test Console<\/title>/);
        expect(r.text).toMatch(/<div id="root">/);
        expect(r.text).toMatch(/\/console\/assets\/main\.css/);
        expect(r.text).toMatch(/\/console\/assets\/main\.js/);
      }
    });

    it('injects a panel map for context, schema, api and mcp', async () => {
      const r = await client.get('/console').expect(200);
      const cfg = JSON.parse(
        r.text.match(/window\.__CONSOLE__=(\{.*?\})<\/script>/)![1],
      );
      expect(cfg.basePath).toBe('/console');
      expect(Object.keys(cfg.panels).sort()).toEqual([
        'api',
        'context',
        'mcp',
        'schema',
      ]);
      expect(cfg.panels.context.apiBase).toBe('/context-explorer/api');
      expect(cfg.panels.schema.apiBase).toBe('/schema-explorer/api');
      expect(cfg.panels.mcp.apiBase).toBe('/mcp-inspector/api');
      // mcp panel carries its remote-connect config.
      expect(cfg.panels.mcp.extra.connect.base).toBe('/mcp-connect/api');
      // api panel points the iframe at the Swagger mount.
      expect(cfg.panels.api.extra.url).toBe('/explorer/');
    });

    it('serves the esbuild client bundle', async () => {
      const r = await client.get('/console/assets/main.js').expect(200);
      expect(r.headers['content-type']).toMatch(
        /application\/javascript|text\/javascript/,
      );
    });
  });

  describe('aggregated panel APIs', () => {
    it('mounts the context-explorer API', async () => {
      const r = await client.get('/context-explorer/api/model').expect(200);
      expect(r.body.bindings).toBeTypeOf('object');
    });

    it('mounts the mcp-inspector API', async () => {
      const r = await client.get('/mcp-inspector/api/manifest').expect(200);
      expect(r.body.tools.map((t: {name: string}) => t.name)).toContain('add');
    });

    it('mounts the Swagger explorer + mcp-connect', async () => {
      await client.get('/explorer/').expect(200);
      await client.get('/mcp-connect/api/targets').expect(200);
    });
  });

  describe('auth gate', () => {
    let gApp: RestApplication;
    let g: ReturnType<typeof supertest>;
    beforeEach(async () => {
      gApp = await makeApp((req, res, next) =>
        req.headers['x-key'] === 'ok' ? next() : res.status(401).end(),
      );
      g = supertest((await gApp.restServer).url);
    });
    afterEach(async () => gApp.stop());

    it('gates the UI and the aggregated APIs without the key', async () => {
      await g.get('/console').expect(401);
      await g.get('/mcp-inspector/api/manifest').expect(401);
      await g.get('/context-explorer/api/model').expect(401);
      await g.get('/mcp-connect/api/targets').expect(401);
    });

    it('allows access with the key', async () => {
      await g.get('/console').set('x-key', 'ok').expect(200);
      await g.get('/mcp-inspector/api/manifest').set('x-key', 'ok').expect(200);
    });

    it('rejects installation without auth or an unsafe local opt-in', async () => {
      const unguarded = new RestApplication({});
      await expect(installConsole(unguarded)).rejects.toThrow(
        /provide `auth`, or pass `unsafeAllowUnauthenticated: true`/,
      );
    });
  });

  describe('chat config injection', () => {
    it('omits config.chat when no chat feature is present', async () => {
      const r = await client.get('/console').expect(200);
      const cfg = JSON.parse(
        r.text.match(/window\.__CONSOLE__=(\{.*?\})<\/script>/)![1],
      );
      expect(cfg.chat).toBeUndefined();
    });

    it('emits config.chat when a feature exposes chatConfig', async () => {
      // Build a minimal fake chat feature (no real ACP logic — just the
      // duck-typed chatConfig property that installConsole reads).
      const fakeChatFeature = {
        id: 'chat',
        apiBase: '/console/chat',
        extra: {},
        chatConfig: {
          enabled: true,
          apiBase: '/console/chat',
          agents: [{id: 'cc', name: 'Claude Code'}],
        },
        install: async () => {},
      };

      const chatApp = new RestApplication({});
      chatApp.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
      chatApp.component(MCPComponent);
      chatApp.configure('servers.MCPServer').to({
        name: 'chat-test',
        version: '1.0.0',
        transports: {stdio: false},
      });
      chatApp.service(Tools);
      await chatApp.get<MCPServer>('servers.MCPServer');
      await installConsole(chatApp, {
        features: [fakeChatFeature],
        unsafeAllowUnauthenticated: true,
      });
      await chatApp.start();

      try {
        const chatClient = supertest((await chatApp.restServer).url);
        const r = await chatClient.get('/console').expect(200);
        const cfg = JSON.parse(
          r.text.match(/window\.__CONSOLE__=(\{.*?\})<\/script>/)![1],
        );
        expect(cfg.chat).toBeDefined();
        expect(cfg.chat.enabled).toBe(true);
        expect(cfg.chat.apiBase).toBe('/console/chat');
        expect(cfg.chat.agents).toEqual([{id: 'cc', name: 'Claude Code'}]);
      } finally {
        await chatApp.stop();
      }
    });
  });
});
