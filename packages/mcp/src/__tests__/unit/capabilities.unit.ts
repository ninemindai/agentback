// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {Context, inject} from '@agentback/context';
import {Application, extensionFor} from '@agentback/core';
import {appResource, mcpServer, tool} from '../../decorators/index.js';
import {
  contributeCapabilities,
  resolveCapabilities,
} from '../../capabilities.js';
import {
  MCP_CAPABILITIES,
  MCPBindings,
  type AppDomainRequest,
  type McpMount,
} from '../../keys.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {resourceContent} from '../../resource-content.js';
import type {MCPServerConfig} from '../../types.js';

// P1-7 phase 1b (docs/proposals/host-extensions.md §4.6–4.7, §13): capability
// contributions, REQUEST_META / REQUEST_MOUNT, and a per-request widget domain.

const SETTINGS = {'acme/settings': {readTool: 'settings_read'}};
const WIDGETS = {'com.example/widgets': {version: '1'}};

let seenMeta: Readonly<Record<string, unknown>> | undefined;
let seenDomainRequest: AppDomainRequest | undefined;
let overrideCalls = 0;

@mcpServer()
class Probe {
  @tool('meta')
  meta(
    @inject(MCPBindings.REQUEST_META, {optional: true})
    meta?: Readonly<Record<string, unknown>>,
    @inject(MCPBindings.REQUEST_MOUNT, {optional: true}) mount?: McpMount,
  ) {
    seenMeta = meta;
    return {meta: meta ?? null, mount: mount ?? null};
  }

  @appResource('ui://probe/widget', {
    domain: req => {
      seenDomainRequest = req;
      return req.client?.info?.name === 'claude-ai'
        ? 'abc.claudemcpcontent.com'
        : undefined;
    },
    prefersBorder: true,
  })
  widget() {
    return '<html></html>';
  }

  @appResource('ui://probe/override', {
    domain: () => {
      overrideCalls++;
      return 'from-fn.example';
    },
  })
  override() {
    return resourceContent(
      {text: '<html></html>'},
      {meta: {ui: {domain: 'per-call.example'}}},
    );
  }

  @appResource('ui://probe/bad', {domain: () => 42 as unknown as string})
  bad() {
    return '<html></html>';
  }
}

async function boot(config: Partial<MCPServerConfig> = {}) {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'phase-1b',
    version: '1.0.0',
    transports: {stdio: false},
    ...config,
  });
  app.service(Probe);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
  seenMeta = undefined;
  seenDomainRequest = undefined;
});

async function connect(
  server: MCPServer,
  opts: {modern?: boolean; name?: string; mount?: McpMount} = {},
): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  if (opts.modern) {
    server.serveTransport(st);
  } else {
    await server.buildServer(opts.mount ? {mount: opts.mount} : {}).connect(st);
  }
  const client = new Client(
    {name: opts.name ?? 'test-client', version: '0.0.0'},
    opts.modern ? {versionNegotiation: {mode: 'auto' as const}} : {},
  );
  await client.connect(ct);
  clients.push(client);
  return client;
}

describe('resolveCapabilities', () => {
  it('merges the config with constant contributions', async () => {
    const {app} = await boot();
    app
      .bind('caps.widgets')
      .to({extensions: WIDGETS})
      .apply(extensionFor(MCP_CAPABILITIES));
    expect(
      resolveCapabilities({capabilities: {extensions: SETTINGS}}, app),
    ).toEqual({
      tools: {},
      resources: {},
      prompts: {},
      extensions: {...SETTINGS, ...WIDGETS},
    });
  });

  it('accepts the same entry twice when the values are deep-equal', async () => {
    const {app} = await boot();
    contributeCapabilities(app, {extensions: SETTINGS}, {key: 'a'});
    contributeCapabilities(app, {extensions: SETTINGS}, {key: 'b'});
    expect(resolveCapabilities({}, app).extensions).toEqual(SETTINGS);
  });

  it('throws on a conflicting entry, naming both sources', async () => {
    const {app} = await boot();
    contributeCapabilities(
      app,
      {extensions: {'acme/settings': {readTool: 'other'}}},
      {key: 'caps.other'},
    );
    expect(() =>
      resolveCapabilities({capabilities: {extensions: SETTINGS}}, app),
    ).toThrow(
      /'acme\/settings'.*MCPServerConfig\.capabilities and capability contribution 'caps\.other'/,
    );
  });

  it('refuses a non-constant contribution', async () => {
    const {app} = await boot();
    app
      .bind('caps.dynamic')
      .toDynamicValue(() => ({extensions: WIDGETS}))
      .apply(extensionFor(MCP_CAPABILITIES));
    expect(() => resolveCapabilities({}, app)).toThrow(
      /'caps\.dynamic' must be a constant/,
    );
  });

  it('refuses framework-owned and non-JSON keys', async () => {
    const {app} = await boot();
    expect(() => contributeCapabilities(app, {tools: {}} as never)).toThrow(
      /tools is not allowed/,
    );
    expect(() =>
      contributeCapabilities(app, {
        extensions: {'acme/x': {fn: (() => 1) as never}},
      }),
    ).toThrow();
  });

  it('makes a conflict a start() error', async () => {
    const {app, server} = await boot({capabilities: {extensions: SETTINGS}});
    // Bound by hand, so nothing checked it at bind time.
    app
      .bind('caps.raw')
      .to({extensions: {'acme/settings': {readTool: 'other'}}})
      .apply(extensionFor(MCP_CAPABILITIES));
    await expect(server.start()).rejects.toThrow(/declared differently/);
  });

  it('refuses an entry named __proto__', async () => {
    const {app} = await boot();
    expect(() =>
      contributeCapabilities(
        app,
        JSON.parse('{"extensions": {"__proto__": {"evil": 1}}}'),
      ),
    ).toThrow(/__proto__/);
  });

  it("reads each binding's own value, not a same-key child override", async () => {
    const {app} = await boot();
    contributeCapabilities(app, {extensions: WIDGETS}, {key: 'caps.k'});
    const child = new Context(app, 'child');
    child.bind('caps.k').toDynamicValue(async () => ({}));
    expect(resolveCapabilities({}, child).extensions).toEqual(WIDGETS);
  });
});

describe('contributeCapabilities', () => {
  it('refuses, at the call, an entry another contribution declares differently', async () => {
    const {app} = await boot();
    contributeCapabilities(app, {extensions: {'x/y': {v: 1}}});
    expect(() =>
      contributeCapabilities(app, {extensions: {'x/y': {v: 2}}}),
    ).toThrow(/declared differently/);
    // Nothing was left bound by the refused call.
    expect(resolveCapabilities({}, app).extensions).toEqual({'x/y': {v: 1}});
  });

  it('refuses, at the call, an entry the server config declares differently — even after start()', async () => {
    const {app, server} = await boot({capabilities: {extensions: SETTINGS}});
    await server.start();
    expect(() =>
      contributeCapabilities(app, {
        extensions: {'acme/settings': {readTool: 'other'}},
      }),
    ).toThrow(/MCPServerConfig\.capabilities/);
    // The server still builds.
    expect(() => server.buildServer()).not.toThrow();
    await server.stop();
  });

  it('accepts entry ids that are not valid binding-key characters', async () => {
    const {app} = await boot();
    contributeCapabilities(app, {extensions: {'a#b': {}}});
    expect(resolveCapabilities({}, app).extensions).toEqual({'a#b': {}});
  });

  it.each([
    ['2025 initialize', false],
    ['2026 server/discover', true],
  ])('reaches a %s client and retracts on uninstall', async (_l, modern) => {
    const {app, server} = await boot({capabilities: {extensions: SETTINGS}});
    const installed = contributeCapabilities(app, {extensions: WIDGETS});
    const c1 = await connect(server, {modern});
    expect(c1.getServerCapabilities()?.extensions).toEqual({
      ...SETTINGS,
      ...WIDGETS,
    });
    await installed.uninstall();
    await installed.uninstall(); // idempotent
    const c2 = await connect(server, {modern});
    expect(c2.getServerCapabilities()?.extensions).toEqual(SETTINGS);
  });

  it('reports the merged set through advertisedCapabilities()', async () => {
    const {app, server} = await boot({capabilities: {extensions: SETTINGS}});
    contributeCapabilities(app, {experimental: WIDGETS});
    expect(server.advertisedCapabilities()).toEqual({
      extensions: SETTINGS,
      experimental: WIDGETS,
    });
  });

  it('never deletes a binding that has since replaced it', async () => {
    const {app} = await boot();
    const installed = contributeCapabilities(
      app,
      {extensions: WIDGETS},
      {key: 'caps.shared'},
    );
    const third = app
      .bind('caps.shared')
      .to({experimental: WIDGETS})
      .apply(extensionFor(MCP_CAPABILITIES));
    await installed.uninstall();
    expect(app.getBinding('caps.shared')).toBe(third);
  });

  it('restores the binding it displaced', async () => {
    const {app} = await boot();
    const original = app
      .bind('caps.shared')
      .to({experimental: WIDGETS})
      .apply(extensionFor(MCP_CAPABILITIES));
    const installed = contributeCapabilities(
      app,
      {extensions: WIDGETS},
      {key: 'caps.shared'},
    );
    await installed.uninstall();
    expect(app.getBinding('caps.shared')).toBe(original);
  });

  it('is advertised by a legacy-protocol constructor-built server too', async () => {
    const {app, server} = await boot({protocol: 'legacy'});
    contributeCapabilities(app, {extensions: WIDGETS});
    await server.start();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.sdkServer.connect(st);
    const client = new Client({name: 'c', version: '0'});
    await client.connect(ct);
    clients.push(client);
    expect(client.getServerCapabilities()?.extensions).toEqual(WIDGETS);
    await server.stop();
  });
});

describe('MCPBindings.REQUEST_META and REQUEST_MOUNT', () => {
  it('binds the request _meta frozen, and the mount when built for one', async () => {
    const {server} = await boot();
    const client = await connect(server, {
      mount: {path: '/mcp/claude', host: 'claude'},
    });
    const res = await client.callTool({
      name: 'meta',
      arguments: {},
      _meta: {'openai/resource': {path: '/tmp/x'}},
    });
    expect(res.structuredContent ?? JSON.parse(textOf(res))).toMatchObject({
      meta: {'openai/resource': {path: '/tmp/x'}},
      mount: {path: '/mcp/claude', host: 'claude'},
    });
    expect(Object.isFrozen(seenMeta)).toBe(true);
    expect(Object.isFrozen(seenMeta?.['openai/resource'])).toBe(true);
  });

  it('is an empty object without request _meta, and leaves no mount on stdio-style serving', async () => {
    const {server} = await boot();
    const client = await connect(server, {modern: true});
    const res = await client.callTool({name: 'meta', arguments: {}});
    const body = (res.structuredContent ?? JSON.parse(textOf(res))) as {
      meta: Record<string, unknown>;
      mount: unknown;
    };
    // The 2026 envelope keys are lifted out by the SDK.
    expect(
      Object.keys(body.meta).filter(k =>
        k.startsWith('io.modelcontextprotocol/'),
      ),
    ).toEqual([]);
    expect(body.mount).toBeNull();
  });
});

describe('nested in-process calls', () => {
  it("shadow the outer request's meta, mount and client", async () => {
    const {app, server} = await boot();
    const outer = new Context(app, 'outer-request');
    outer.bind(MCPBindings.REQUEST_META).to({'openai/resource': {path: '/x'}});
    outer.bind(MCPBindings.REQUEST_MOUNT).to({path: '/mcp', host: 'claude'});
    outer
      .bind(MCPBindings.REQUEST_CLIENT)
      .to({era: 'modern', canRoundTrip: true});
    const res = (await server.callTool('meta', {}, {ctx: outer})) as {
      meta: unknown;
      mount: unknown;
    };
    expect(res).toEqual({meta: null, mount: null});
  });
});

describe('simulate (inspector client profiles)', () => {
  it('binds a simulated client, mount and meta for one in-process call', async () => {
    const {server} = await boot();
    const res = await server.callTool(
      'meta',
      {},
      {
        simulate: {
          mount: {host: 'claude'},
          meta: {'openai/resource': {path: '/p'}},
        },
      },
    );
    expect(res).toEqual({
      meta: {'openai/resource': {path: '/p'}},
      mount: {host: 'claude'},
    });
    const {contents} = await server.readResource('widget', {
      simulate: {
        client: {era: 'modern', info: {name: 'claude-ai'}, canRoundTrip: true},
      },
    });
    expect(contents[0]._meta).toMatchObject({
      ui: {domain: 'abc.claudemcpcontent.com'},
    });
  });
});

describe('@appResource({domain}) as a function', () => {
  async function readUi(client: Client, uri: string) {
    const {contents} = await client.readResource({uri});
    return (contents[0]._meta as {ui?: Record<string, unknown>} | undefined)
      ?.ui;
  }

  it('resolves per request from the client and keeps the static ui keys', async () => {
    const {server} = await boot();
    const claude = await connect(server, {name: 'claude-ai'});
    expect(await readUi(claude, 'ui://probe/widget')).toEqual({
      prefersBorder: true,
      domain: 'abc.claudemcpcontent.com',
    });
    const other = await connect(server, {name: 'chatgpt'});
    expect(await readUi(other, 'ui://probe/widget')).toEqual({
      prefersBorder: true,
    });
  });

  it('hands the resolver the mount, request _meta and context', async () => {
    const {server} = await boot();
    const client = await connect(server, {
      mount: {path: '/mcp/claude', host: 'claude'},
    });
    await client.readResource({uri: 'ui://probe/widget'});
    expect(seenDomainRequest?.mount).toEqual({
      path: '/mcp/claude',
      host: 'claude',
    });
    expect(seenDomainRequest?.client?.era).toBe('legacy');
    expect(seenDomainRequest?.meta).toBeDefined();
    expect(seenDomainRequest?.context).toBeDefined();
  });

  it('lets a per-call resourceContent domain win, without running the resolver', async () => {
    const {server} = await boot();
    const client = await connect(server);
    overrideCalls = 0;
    expect(await readUi(client, 'ui://probe/override')).toEqual({
      domain: 'per-call.example',
    });
    expect(overrideCalls).toBe(0);
  });

  it('refuses a resolver that returns a non-string', async () => {
    const {server} = await boot();
    const client = await connect(server);
    await expect(
      client.readResource({uri: 'ui://probe/bad'}),
    ).rejects.toThrow();
    await expect(server.readResource('bad')).rejects.toThrow(
      /domain function returned 42/,
    );
  });

  it('runs on an in-process readResource with no request client', async () => {
    const {server} = await boot();
    const {contents} = await server.readResource('widget');
    expect(contents[0]._meta).toEqual({ui: {prefersBorder: true}});
    expect(seenDomainRequest?.client).toBeUndefined();
  });
});

function textOf(res: unknown): string {
  return (res as {content: {text: string}[]}).content[0].text;
}
