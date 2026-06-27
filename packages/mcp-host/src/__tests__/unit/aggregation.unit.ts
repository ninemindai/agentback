// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  compileUriTemplate,
  createMcpHost,
  mcpHostBuilder,
  type McpHost,
  type UpstreamConfig,
} from '../../index.js';

/** Build a fake upstream and return a 'custom' upstream config wired to it. */
async function asUpstream(
  name: string,
  server: McpServer,
): Promise<UpstreamConfig> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return {name, transport: 'custom', clientTransport};
}

/** Upstream A: a tool, a prompt, a fixed resource, and a wide template. */
function makeUpstreamA() {
  const s = new McpServer({name: 'a-srv', version: '0.0.0'});
  s.registerTool(
    'add',
    {inputSchema: {a: z.number(), b: z.number()}},
    async ({a, b}) => ({content: [{type: 'text', text: String(a + b)}]}),
  );
  s.registerPrompt('greet', {description: 'a greeting'}, async () => ({
    messages: [
      {
        role: 'user' as const,
        content: {type: 'text' as const, text: 'hello from A'},
      },
    ],
  }));
  s.registerResource('one', 'mem://a/one', {}, async uri => ({
    contents: [{uri: uri.href, text: 'A-ONE'}],
  }));
  s.registerResource(
    'k-items',
    new ResourceTemplate('k://{a}/{b}', {list: undefined}),
    {},
    async uri => ({contents: [{uri: uri.href, text: `A:${uri.href}`}]}),
  );
  return s;
}

/** Upstream B: a tool, the same prompt name as A, a resource, a narrower template. */
function makeUpstreamB() {
  const s = new McpServer({name: 'b-srv', version: '0.0.0'});
  s.registerTool('echo', {inputSchema: {text: z.string()}}, async ({text}) => ({
    content: [{type: 'text', text}],
  }));
  s.registerPrompt('greet', {description: 'b greeting'}, async () => ({
    messages: [
      {
        role: 'user' as const,
        content: {type: 'text' as const, text: 'hello from B'},
      },
    ],
  }));
  s.registerResource('two', 'mem://b/two', {}, async uri => ({
    contents: [{uri: uri.href, text: 'B-TWO'}],
  }));
  s.registerResource(
    'k-x',
    new ResourceTemplate('k://x/{b}', {list: undefined}),
    {},
    async uri => ({contents: [{uri: uri.href, text: `B:${uri.href}`}]}),
  );
  return s;
}

/** Upstream with tools only — no prompts/resources capability at all. */
function makeToolsOnlyUpstream() {
  const s = new McpServer({name: 'tools-only', version: '0.0.0'});
  s.registerTool('ping', {}, async () => ({
    content: [{type: 'text', text: 'pong'}],
  }));
  return s;
}

describe('mcp-host aggregation (prompts + resources)', () => {
  let host: McpHost | undefined;
  let client: Client | undefined;
  const upstreamServers: McpServer[] = [];

  async function trackedUpstream(name: string, s: McpServer) {
    upstreamServers.push(s);
    return asUpstream(name, s);
  }

  async function connectConsumer(h: McpHost) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await h.connect(serverSide);
    client = new Client({name: 'consumer', version: '0.0.0'});
    await client.connect(clientSide);
    return client;
  }

  afterEach(async () => {
    await client?.close().catch(() => {});
    await host?.close().catch(() => {});
    await Promise.all(upstreamServers.map(s => s.close().catch(() => {})));
    upstreamServers.length = 0;
    host = undefined;
    client = undefined;
  });

  it('prefixes tools and prompts with the upstream name', async () => {
    host = await createMcpHost({
      upstreams: [
        await trackedUpstream('a', makeUpstreamA()),
        await trackedUpstream('b', makeUpstreamB()),
      ],
    });
    const c = await connectConsumer(host);
    const toolNames = (await c.listTools()).tools.map(t => t.name).sort();
    expect(toolNames).toEqual(['a__add', 'b__echo']);
    const promptNames = (await c.listPrompts()).prompts.map(p => p.name).sort();
    expect(promptNames).toEqual(['a__greet', 'b__greet']);
  });

  it('proxies prompts/get to the owning upstream, prefix stripped', async () => {
    host = await createMcpHost({
      upstreams: [
        await trackedUpstream('a', makeUpstreamA()),
        await trackedUpstream('b', makeUpstreamB()),
      ],
    });
    const c = await connectConsumer(host);
    const a = await c.getPrompt({name: 'a__greet'});
    expect(a.messages[0].content).toEqual({type: 'text', text: 'hello from A'});
    const b = await c.getPrompt({name: 'b__greet'});
    expect(b.messages[0].content).toEqual({type: 'text', text: 'hello from B'});
    await expect(c.getPrompt({name: 'nope__greet'})).rejects.toThrow(
      /unknown prompt/,
    );
  });

  it('throws at connect on prompt name collision when prefixing is off', async () => {
    await expect(
      createMcpHost({
        upstreams: [
          await trackedUpstream('a', makeUpstreamA()),
          await trackedUpstream('b', makeUpstreamB()),
        ],
        prefix: false,
      }),
    ).rejects.toThrow(/prompt name collision on 'greet'/);
  });

  it('merges resources/list and routes resources/read by exact URI', async () => {
    host = await createMcpHost({
      upstreams: [
        await trackedUpstream('a', makeUpstreamA()),
        await trackedUpstream('b', makeUpstreamB()),
      ],
    });
    const c = await connectConsumer(host);
    const uris = (await c.listResources()).resources.map(r => r.uri).sort();
    expect(uris).toEqual(['mem://a/one', 'mem://b/two']);
    const one = await c.readResource({uri: 'mem://a/one'});
    expect(one.contents[0]).toMatchObject({text: 'A-ONE'});
    const two = await c.readResource({uri: 'mem://b/two'});
    expect(two.contents[0]).toMatchObject({text: 'B-TWO'});
    await expect(c.readResource({uri: 'mem://nope'})).rejects.toThrow(
      /unknown resource/,
    );
  });

  it('throws at connect when two upstreams list the same resource URI', async () => {
    const dupA = new McpServer({name: 'dup-a', version: '0.0.0'});
    dupA.registerResource('shared', 'mem://shared', {}, async uri => ({
      contents: [{uri: uri.href, text: 'a'}],
    }));
    const dupB = new McpServer({name: 'dup-b', version: '0.0.0'});
    dupB.registerResource('shared', 'mem://shared', {}, async uri => ({
      contents: [{uri: uri.href, text: 'b'}],
    }));
    await expect(
      createMcpHost({
        upstreams: [
          await trackedUpstream('a', dupA),
          await trackedUpstream('b', dupB),
        ],
      }),
    ).rejects.toThrow(/resource URI collision on 'mem:\/\/shared'/);
  });

  it('lists templates pass-through and routes reads by longest literal match', async () => {
    host = await createMcpHost({
      upstreams: [
        await trackedUpstream('a', makeUpstreamA()),
        await trackedUpstream('b', makeUpstreamB()),
      ],
    });
    const c = await connectConsumer(host);
    const templates = (await c.listResourceTemplates()).resourceTemplates
      .map(t => t.uriTemplate)
      .sort();
    expect(templates).toEqual(['k://x/{b}', 'k://{a}/{b}']);
    // 'k://x/9' matches both templates — B's 'k://x/{b}' has more literal
    // characters, so B owns the read.
    const xRead = await c.readResource({uri: 'k://x/9'});
    expect(xRead.contents[0]).toMatchObject({text: 'B:k://x/9'});
    // 'k://y/9' only matches A's wide template.
    const yRead = await c.readResource({uri: 'k://y/9'});
    expect(yRead.contents[0]).toMatchObject({text: 'A:k://y/9'});
  });

  it('declares prompts/resources capabilities only when an upstream has them', async () => {
    host = await createMcpHost({
      upstreams: [await trackedUpstream('t', makeToolsOnlyUpstream())],
    });
    const c = await connectConsumer(host);
    const caps = c.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.prompts).toBeUndefined();
    expect(caps?.resources).toBeUndefined();
    expect((await c.listTools()).tools.map(t => t.name)).toEqual(['t__ping']);
  });

  it('declares the capabilities when an upstream exposes them', async () => {
    host = await createMcpHost({
      upstreams: [
        await trackedUpstream('t', makeToolsOnlyUpstream()),
        await trackedUpstream('a', makeUpstreamA()),
      ],
    });
    const c = await connectConsumer(host);
    const caps = c.getServerCapabilities();
    expect(caps?.prompts).toBeDefined();
    expect(caps?.resources).toBeDefined();
  });

  it('keeps the fluent builder working for custom transports', async () => {
    const s = makeToolsOnlyUpstream();
    upstreamServers.push(s);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await s.connect(serverTransport);
    host = await createMcpHost({
      upstreams: mcpHostBuilder().custom('t', clientTransport).build(),
    });
    const c = await connectConsumer(host);
    expect((await c.listTools()).tools).toHaveLength(1);
  });
});

describe('compileUriTemplate', () => {
  it('matches simple {var} segments without crossing "/"', () => {
    const {regex} = compileUriTemplate('item://{id}');
    expect(regex.test('item://42')).toBe(true);
    expect(regex.test('item://a/b')).toBe(false);
  });

  it('lets {+var} cross "/" boundaries', () => {
    const {regex} = compileUriTemplate('file:///{+path}');
    expect(regex.test('file:///a/b/c.txt')).toBe(true);
  });

  it('scores specificity by literal length', () => {
    expect(compileUriTemplate('k://x/{b}').literalLength).toBeGreaterThan(
      compileUriTemplate('k://{a}/{b}').literalLength,
    );
  });
});
