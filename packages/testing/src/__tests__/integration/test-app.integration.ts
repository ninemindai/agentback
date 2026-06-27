// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {inject} from '@agentback/context';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, mcpServer, tool} from '@agentback/mcp';
import {authorize} from '@agentback/authorization';
import {defineRoute} from '@agentback/client';
import {createTestApp} from '../../test-app.js';

const Msg = z.object({msg: z.string()});
const MsgPath = z.object({suffix: z.string()});
const Empty = z.object({});

@api({basePath: '/t'})
@mcpServer()
class HybridController {
  constructor(@inject('services.msg') private msg: string) {}

  @get('/msg/{suffix}', {path: MsgPath, response: Msg})
  async getMsg(input: {
    path: z.infer<typeof MsgPath>;
  }): Promise<z.infer<typeof Msg>> {
    return {msg: `${this.msg}-${input.path.suffix}`};
  }

  @tool('get_msg', {input: Empty, output: Msg})
  async toolMsg(_input: z.infer<typeof Empty>): Promise<z.infer<typeof Msg>> {
    return {msg: this.msg};
  }

  @authorize({scopes: ['secret:read']})
  @tool('secret_msg', {input: Empty, output: Msg})
  async secret(_input: z.infer<typeof Empty>): Promise<z.infer<typeof Msg>> {
    return {msg: 'secret'};
  }
}

class FixtureApp extends RestApplication {
  constructor() {
    super({});
    this.component(MCPComponent);
    this.bind('services.msg').to('original');
    this.restController(HybridController);
    this.service(HybridController);
  }
}

const getMsg = defineRoute('GET', '/t/msg/{suffix}', {
  path: MsgPath,
  response: Msg,
});

describe('createTestApp', () => {
  it('boots on an ephemeral port and serves typed calls', async () => {
    const t = await createTestApp(FixtureApp);
    try {
      expect(t.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+/);
      const out = await t.call(getMsg, {path: {suffix: 'a'}});
      expect(out).toEqual({msg: 'original-a'});
    } finally {
      await t.stop();
    }
  });

  it('binding overrides win over the constructor', async () => {
    const t = await createTestApp(FixtureApp, {
      overrides: {'services.msg': 'overridden'},
    });
    try {
      const out = await t.call(getMsg, {path: {suffix: 'b'}});
      expect(out).toEqual({msg: 'overridden-b'});
    } finally {
      await t.stop();
    }
  });

  it('exposes raw supertest via t.http', async () => {
    const t = await createTestApp(FixtureApp);
    try {
      const r = await t.http.get('/openapi.json').expect(200);
      expect(r.body.openapi).toBeDefined();
    } finally {
      await t.stop();
    }
  });

  it('serves an in-process Web Request→Response via t.fetch', async () => {
    const t = await createTestApp(FixtureApp);
    try {
      const res = await t.fetch('/t/msg/web');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({msg: 'original-web'});
    } finally {
      await t.stop();
    }
  });

  it('t.fetch and t.http agree on body + status for the same route', async () => {
    const t = await createTestApp(FixtureApp);
    try {
      const viaFetch = await t.fetch('/t/msg/agree');
      const viaHttp = await t.http.get('/t/msg/agree');
      expect(viaFetch.status).toBe(viaHttp.status);
      expect(await viaFetch.json()).toEqual(viaHttp.body);
    } finally {
      await t.stop();
    }
  });

  it('connects an in-memory MCP client', async () => {
    const t = await createTestApp(FixtureApp);
    try {
      const tools = await t.mcp.listTools();
      expect(tools.tools.map(x => x.name).sort()).toEqual([
        'get_msg',
        'secret_msg',
      ]);
      const result = await t.mcp.callTool({name: 'get_msg', arguments: {}});
      expect(
        (result as unknown as {structuredContent: {msg: string}})
          .structuredContent,
      ).toEqual({msg: 'original'});
    } finally {
      await t.stop();
    }
  });

  it('mcpScopes builds a scope-filtered session', async () => {
    const t = await createTestApp(FixtureApp, {mcpScopes: ['other:scope']});
    try {
      const tools = await t.mcp.listTools();
      expect(tools.tools.map(x => x.name)).toEqual(['get_msg']);
    } finally {
      await t.stop();
    }
  });

  it('stop is idempotent and Symbol.asyncDispose works', async () => {
    const t = await createTestApp(FixtureApp);
    await t.stop();
    await t.stop();
    await t[Symbol.asyncDispose]();
  });

  it('accepts a factory function', async () => {
    const t = await createTestApp(() => new FixtureApp());
    try {
      expect(t.app).toBeInstanceOf(FixtureApp);
    } finally {
      await t.stop();
    }
  });

  it('throws a clear error for missing surfaces', async () => {
    const {Application} = await import('@agentback/core');
    const t = await createTestApp(new Application());
    try {
      expect(() => t.url).toThrow(/no REST server/);
      expect(() => t.mcp).toThrow(/no MCP server/);
    } finally {
      await t.stop();
    }
  });
});
