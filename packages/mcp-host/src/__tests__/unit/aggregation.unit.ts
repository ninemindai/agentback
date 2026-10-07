// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {
  createMcpHandler,
  InMemoryTransport,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import {
  Client,
  ProtocolError as ClientProtocolError,
  ProtocolErrorCode as ClientProtocolErrorCode,
} from '@modelcontextprotocol/client';

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
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

/**
 * Serve a Web `fetch` handler on an ephemeral port. A small adapter instead
 * of `@modelcontextprotocol/node`, which this package does not depend on;
 * the response body is streamed, so SSE (`subscriptions/listen`) works.
 */
async function serveFetch(fetchFn: (request: Request) => Promise<Response>) {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await fetchFn(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        ...(chunks.length ? {body: Buffer.concat(chunks)} : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body)
      for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Upstream A: a tool, a prompt, a fixed resource, and a wide template. */
function makeUpstreamA() {
  const s = new McpServer({name: 'a-srv', version: '0.0.0'});
  s.registerTool(
    'add',
    {inputSchema: z.object({a: z.number(), b: z.number()})},
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
  s.registerTool(
    'echo',
    {inputSchema: z.object({text: z.string()})},
    async ({text}) => ({
      content: [{type: 'text', text}],
    }),
  );
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

  it('re-syncs an upstream’s tools when it announces list_changed', async () => {
    const a = makeUpstreamA();
    const old = a.registerTool('old', {}, async () => ({
      content: [{type: 'text', text: 'old'}],
    }));
    host = await createMcpHost({
      upstreams: [
        await trackedUpstream('a', a),
        await trackedUpstream('b', makeUpstreamB()),
      ],
    });
    const seen: string[][] = [];
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await host.connect(serverSide);
    client = new Client(
      {name: 'consumer', version: '0.0.0'},
      {
        listChanged: {
          tools: {
            debounceMs: 0,
            onChanged: (_err, tools) =>
              seen.push((tools ?? []).map(t => t.name).sort()),
          },
        },
      },
    );
    await client.connect(clientSide);

    // The upstream adds one tool and drops another after the gateway connected.
    a.registerTool(
      'sub',
      {inputSchema: z.object({a: z.number(), b: z.number()})},
      async ({a, b}) => ({
        content: [{type: 'text', text: String(a - b)}],
      }),
    );
    old.remove();
    await expect
      .poll(
        async () => (await client!.listTools()).tools.map(t => t.name).sort(),
        {timeout: 5000},
      )
      .toEqual(['a__add', 'a__sub', 'b__echo']);

    const r = await client.callTool({name: 'a__sub', arguments: {a: 5, b: 2}});
    expect(r.content).toEqual([{type: 'text', text: '3'}]);
    // The other upstream's routes survive a re-sync of this one.
    const e = await client.callTool({name: 'b__echo', arguments: {text: 'hi'}});
    expect(e.isError).toBeFalsy();
    // And the gateway tells its own client the list changed.
    await expect
      .poll(() => seen.at(-1), {timeout: 5000})
      .toEqual(['a__add', 'a__sub', 'b__echo']);
  });

  it('re-syncs a 2026-07-28 upstream served over HTTP', async () => {
    // AgentBack upstreams default to `protocol: 'both'`, so the gateway's
    // client speaks 2026-07-28 to them and hears list_changed only through
    // the `subscriptions/listen` stream its `listChanged` option opens. A
    // stateless 2025 fallback has no stream at all, so passing proves that path.
    let late = false;
    const handler = createMcpHandler(() => {
      const s = new McpServer({name: 'modern', version: '0.0.0'});
      s.registerTool('a', {}, async () => ({
        content: [{type: 'text', text: 'a'}],
      }));
      if (late) {
        s.registerTool('b', {}, async () => ({
          content: [{type: 'text', text: 'b'}],
        }));
      }
      return s;
    });
    const upstream = await serveFetch(req => handler.fetch(req));
    try {
      host = await createMcpHost({
        upstreams: [{name: 'm', transport: 'http', url: upstream.url}],
      });
      const c = await connectConsumer(host);
      const names = async () =>
        (await c.listTools()).tools.map(t => t.name).sort();
      expect(await names()).toEqual(['m__a']);

      late = true;
      // The listen stream opens asynchronously after connect, so keep
      // announcing until the gateway has re-synced. The interval must exceed
      // the SDK client's 300 ms list_changed debounce, which restarts on
      // every notification: announce faster and the re-list never runs.
      await expect
        .poll(
          async () => {
            handler.notify.toolsChanged();
            return names();
          },
          {timeout: 5000, interval: 500},
        )
        .toEqual(['m__a', 'm__b']);
      const r = await c.callTool({name: 'm__b', arguments: {}});
      expect(r.content).toEqual([{type: 'text', text: 'b'}]);
    } finally {
      await host?.close().catch(() => {});
      host = undefined;
      await handler.close();
      await upstream.close();
    }
  });

  it('throws at connect on tool name collision when prefixing is off', async () => {
    await expect(
      createMcpHost({
        upstreams: [
          await trackedUpstream('x', makeToolsOnlyUpstream()),
          await trackedUpstream('y', makeToolsOnlyUpstream()),
        ],
        prefix: false,
      }),
    ).rejects.toThrow(/tool name collision on 'ping'/);
  });

  it('keeps the existing owner when a re-sync re-lists a taken name', async () => {
    const y = new McpServer({name: 'y-srv', version: '0.0.0'});
    y.registerTool('other', {}, async () => ({
      content: [{type: 'text', text: 'other'}],
    }));
    host = await createMcpHost({
      upstreams: [
        await trackedUpstream('x', makeToolsOnlyUpstream()),
        await trackedUpstream('y', y),
      ],
      prefix: false,
    });
    const c = await connectConsumer(host);

    // y now also offers `ping`, which x already owns, plus a marker tool that
    // shows when the re-sync has happened.
    y.registerTool('ping', {}, async () => ({
      content: [{type: 'text', text: 'pong from y'}],
    }));
    y.registerTool('marker', {}, async () => ({
      content: [{type: 'text', text: 'marker'}],
    }));
    await expect
      .poll(async () => (await c.listTools()).tools.map(t => t.name).sort(), {
        timeout: 5000,
      })
      .toEqual(['marker', 'other', 'ping']);

    const r = await c.callTool({name: 'ping', arguments: {}});
    expect(r.content).toEqual([{type: 'text', text: 'pong'}]);
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

describe('SDK cross-package error branding', () => {
  // mcp-host is a dual-role process: errors are raised by a `Client` (from
  // @modelcontextprotocol/client) but `emptyOnMethodNotFound` classifies them
  // with `ProtocolError` imported from @modelcontextprotocol/server. The two
  // packages bundle *separate* copies of the class, so this only works because
  // v2 brand-matches via `Symbol.hasInstance`. The SDK docs warn the brand
  // degrades to plain prototype `instanceof` if either copy predates the
  // brand-aware release — which would silently turn "upstream has no prompts"
  // into a thrown error and break aggregation of tools-only upstreams. Pin it.
  it('matches a client-raised ProtocolError against the server class', () => {
    const raised = new ClientProtocolError(
      ClientProtocolErrorCode.MethodNotFound,
      'Method not found',
    );
    expect(raised instanceof ProtocolError).toBe(true);
    expect(raised.code).toBe(ProtocolErrorCode.MethodNotFound);
  });
});
