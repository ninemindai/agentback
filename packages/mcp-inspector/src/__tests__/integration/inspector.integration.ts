// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {
  MCPComponent,
  MCPServer,
  mcpServer,
  prompt,
  resource,
  tool,
} from '@agentback/mcp';
import {installInspector} from '../../index.js';

const EchoInput = z.object({text: z.string().min(1)});
const AddInput = z.object({a: z.number().int(), b: z.number().int()});
const AddOutput = z.object({sum: z.number().int()});

@mcpServer()
class EchoTools {
  @tool('echo', {description: 'echo back', input: EchoInput})
  echo(input: z.infer<typeof EchoInput>) {
    return {echoed: input.text};
  }

  @tool('add', {input: AddInput, output: AddOutput})
  add(input: z.infer<typeof AddInput>): z.infer<typeof AddOutput> {
    return {sum: input.a + input.b};
  }

  @resource('demo://greeting', {
    name: 'greeting',
    description: 'a greeting',
    mimeType: 'text/plain',
  })
  greeting() {
    return 'hello from resource';
  }

  @prompt('welcome', {description: 'a welcome prompt'})
  welcome() {
    return 'Welcome!';
  }
}

describe('mcp-inspector', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'inspector-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(EchoTools);
    // Ensure the MCP server is instantiated/bound before installing.
    await app.get<MCPServer>('servers.MCPServer');
    await installInspector(app, {title: 'MCP Test'});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterEach(async () => app.stop());

  describe('UI surface', () => {
    it('serves the inspector HTML shell at /mcp-inspector and /mcp-inspector/', async () => {
      for (const path of ['/mcp-inspector', '/mcp-inspector/']) {
        const r = await client.get(path).expect(200);
        expect(r.headers['content-type']).toMatch(/text\/html/);
        expect(r.text).toMatch(/<title>MCP Test<\/title>/);
        expect(r.text).toMatch(/<div id="root">/);
        expect(r.text).toMatch(/\/mcp-inspector\/assets\/main\.js/);
      }
    });

    it('serves the esbuild client bundle', async () => {
      const r = await client.get('/mcp-inspector/assets/main.js').expect(200);
      expect(r.headers['content-type']).toMatch(
        /application\/javascript|text\/javascript/,
      );
    });
  });

  describe('manifest API', () => {
    it('returns server info + tool list', async () => {
      const r = await client.get('/mcp-inspector/api/manifest').expect(200);
      expect(r.body.server).toEqual({name: 'inspector-test', version: '0.0.0'});
      expect(r.body.tools.map((t: {name: string}) => t.name).sort()).toEqual([
        'add',
        'echo',
      ]);
    });

    it('emits a Zod-derived inputSchema per tool', async () => {
      const r = await client.get('/mcp-inspector/api/manifest').expect(200);
      const echo = r.body.tools.find((t: {name: string}) => t.name === 'echo');
      expect(echo.inputSchema).toMatchObject({
        type: 'object',
        properties: {text: {type: 'string', minLength: 1}},
        required: ['text'],
      });
    });

    it('emits outputSchema only for tools that declare one', async () => {
      const r = await client.get('/mcp-inspector/api/manifest').expect(200);
      const echo = r.body.tools.find((t: {name: string}) => t.name === 'echo');
      const add = r.body.tools.find((t: {name: string}) => t.name === 'add');
      expect(echo.outputSchema).toBeUndefined();
      expect(add.outputSchema).toMatchObject({
        type: 'object',
        properties: {sum: {type: 'integer'}},
        required: ['sum'],
      });
    });

    it('lists resources and prompts', async () => {
      const r = await client.get('/mcp-inspector/api/manifest').expect(200);
      expect(r.body.resources).toEqual([
        {
          name: 'greeting',
          uri: 'demo://greeting',
          description: 'a greeting',
          mimeType: 'text/plain',
        },
      ]);
      expect(r.body.prompts).toEqual([
        {name: 'welcome', description: 'a welcome prompt'},
      ]);
    });
  });

  describe('tool invocation API', () => {
    it('runs a tool and returns the raw result', async () => {
      const r = await client
        .post('/mcp-inspector/api/tools/echo/call')
        .send({text: 'hi'})
        .expect(200);
      expect(r.body).toEqual({echoed: 'hi'});
    });

    it('returns 400 with Zod issues on invalid input', async () => {
      const r = await client
        .post('/mcp-inspector/api/tools/echo/call')
        .send({text: ''})
        .expect(400);
      expect(r.body.error.statusCode).toBe(400);
      expect(r.body.error.message).toMatch(/Invalid input for tool echo: text/);
      expect(r.body.error.details[0]).toMatchObject({code: 'too_small'});
    });

    it('returns 400 on unknown tool', async () => {
      const r = await client
        .post('/mcp-inspector/api/tools/nope/call')
        .send({})
        .expect(400);
      expect(r.body.error.message).toMatch(/Unknown tool/);
    });

    it('routes multi-arg tools correctly', async () => {
      const r = await client
        .post('/mcp-inspector/api/tools/add/call')
        .send({a: 2, b: 40})
        .expect(200);
      expect(r.body).toEqual({sum: 42});
    });
  });

  describe('remote-connect mode', () => {
    it('omits connect config in the shell when not enabled', async () => {
      const r = await client.get('/mcp-inspector').expect(200);
      // The default app (beforeEach) did not pass `connect`.
      expect(r.text).toMatch(/"connect":null/);
    });
  });

  describe('remote-connect mode (enabled)', () => {
    let capp: RestApplication;
    let cclient: ReturnType<typeof supertest>;

    beforeEach(async () => {
      capp = new RestApplication({});
      capp.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
      capp.component(MCPComponent);
      capp.configure('servers.MCPServer').to({
        name: 'inspector-connect',
        version: '0.0.0',
        transports: {stdio: false},
      });
      capp.service(EchoTools);
      await capp.get<MCPServer>('servers.MCPServer');
      await installInspector(capp, {connect: true});
      await capp.start();
      cclient = supertest((await capp.restServer).url);
    });
    afterEach(async () => capp.stop());

    it('injects connect base + callback path into the shell config', async () => {
      const r = await cclient.get('/mcp-inspector').expect(200);
      expect(r.text).toContain('"base":"/mcp-connect/api"');
      expect(r.text).toContain('"callbackPath":"/mcp-connect/oauth/callback"');
    });

    it('mounts the mcp-connect target API', async () => {
      const r = await cclient.get('/mcp-connect/api/targets').expect(200);
      expect(r.body).toEqual([]);
    });
  });

  describe('resource & prompt API', () => {
    it('reads a resource into the MCP contents shape', async () => {
      const r = await client
        .post('/mcp-inspector/api/resources/greeting/read')
        .expect(200);
      expect(r.body).toEqual({
        contents: [
          {
            uri: 'demo://greeting',
            mimeType: 'text/plain',
            text: 'hello from resource',
          },
        ],
      });
    });

    it('gets a prompt into the MCP messages shape', async () => {
      const r = await client
        .post('/mcp-inspector/api/prompts/welcome/get')
        .expect(200);
      expect(r.body).toEqual({
        messages: [{role: 'user', content: {type: 'text', text: 'Welcome!'}}],
      });
    });

    it('returns 400 on unknown resource and prompt', async () => {
      const res = await client
        .post('/mcp-inspector/api/resources/nope/read')
        .expect(400);
      expect(res.body.error.message).toMatch(/Unknown resource/);
      const pr = await client
        .post('/mcp-inspector/api/prompts/nope/get')
        .expect(400);
      expect(pr.body.error.message).toMatch(/Unknown prompt/);
    });
  });
});
