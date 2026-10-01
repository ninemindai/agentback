// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {Application} from '@agentback/core';
import {
  authInfoToPrincipals,
  MCPComponent,
  mcpServer,
  type MCPServer,
  tool,
} from '@agentback/mcp';
import {securityId, type UserProfile} from '@agentback/security';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {InMemorySettingsStore, installSettings} from '../../index.js';

const Settings = z.object({
  units: z.enum(['mm', 'in']).default('mm').meta({title: 'Measurement units'}),
  showGrid: z.boolean().default(false).meta({title: 'Show grid'}),
  zoom: z.number().int().min(1).max(10).default(3).meta({title: 'Zoom'}),
});

@mcpServer()
class Library {
  @tool('cad_library')
  library() {
    return 'library';
  }
  @tool('needs_id', {input: z.object({id: z.string()})})
  needsId(_input: {id: string}) {
    return 'x';
  }
}

const alice = {[securityId]: 'alice'} as UserProfile;
const bob = {[securityId]: 'bob'} as UserProfile;

async function boot() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'bits',
    version: '1.0.0',
    transports: {stdio: false},
  });
  app.service(Library);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()));
});

async function connect(server: MCPServer, modern: boolean) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server.serveTransport(st);
  const client = new Client(
    {name: 'c', version: '0'},
    modern ? {versionNegotiation: {mode: 'auto' as const}} : {},
  );
  await client.connect(ct);
  clients.push(client);
  return client;
}

describe('installSettings', () => {
  it.each([
    ['2025 initialize', false],
    ['2026 server/discover', true],
  ])(
    'advertises openai/settings to a %s client and lists both tools',
    async (_l, modern) => {
      const {app, server} = await boot();
      await installSettings(app, {
        schema: Settings,
        store: new InMemorySettingsStore(),
      });
      const client = await connect(server, modern);
      const cap = {readTool: 'settings_read', updateTool: 'settings_update'};
      expect(client.getServerCapabilities()?.extensions).toEqual({
        'openai/settings': cap,
      });
      if (!modern) {
        expect(client.getServerCapabilities()?.experimental).toEqual({
          'openai/settings': cap,
        });
      }
      const {tools} = await client.listTools();
      const read = tools.find(t => t.name === 'settings_read')!;
      const update = tools.find(t => t.name === 'settings_update')!;
      expect(read.annotations?.readOnlyHint).toBe(true);
      expect(read.outputSchema).toBeDefined();
      expect(
        (update.inputSchema.properties?.set as {minProperties?: number})
          .minProperties,
      ).toBe(1);
    },
  );

  it('returns the schema without defaults, and default values', async () => {
    const {app, server} = await boot();
    await installSettings(app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
      layout: [
        {
          kind: 'group',
          title: 'Display',
          items: [
            {kind: 'property', property: 'units'},
            {kind: 'tool', tool: 'cad_library', title: 'Browse parts…'},
          ],
        },
      ],
    });
    const res = (await server.callTool(
      'settings_read',
      {},
      {principal: alice},
    )) as {
      schema: {properties: Record<string, object>};
      values: unknown;
      layout: unknown;
    };
    expect(res.schema.properties.units).toEqual({
      type: 'string',
      title: 'Measurement units',
      enum: ['mm', 'in'],
    });
    expect(res.schema.properties.zoom).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    });
    expect(JSON.stringify(res.schema)).not.toContain('default');
    expect(res.values).toEqual({units: 'mm', showGrid: false, zoom: 3});
    expect(res.layout).toHaveLength(1);
  });

  it('keeps each verified user in their own bucket', async () => {
    const {app, server} = await boot();
    await installSettings(app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
    });
    const updated = await server.callTool(
      'settings_update',
      {set: {units: 'in'}},
      {principal: alice},
    );
    expect(updated).toEqual({values: {units: 'in', showGrid: false, zoom: 3}});
    await server.callTool(
      'settings_update',
      {set: {showGrid: true}},
      {principal: alice},
    );
    expect(
      (
        (await server.callTool('settings_read', {}, {principal: alice})) as {
          values: unknown;
        }
      ).values,
    ).toEqual({units: 'in', showGrid: true, zoom: 3});
    expect(
      (
        (await server.callTool('settings_read', {}, {principal: bob})) as {
          values: unknown;
        }
      ).values,
    ).toEqual({units: 'mm', showGrid: false, zoom: 3});
  });

  it('refuses an update from a principal synthesized from a clientId', async () => {
    const {app, server} = await boot();
    await installSettings(app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
    });
    const host = authInfoToPrincipals({
      token: 't',
      clientId: 'chatgpt-app',
      scopes: [],
    }).user!;
    await expect(
      server.callTool(
        'settings_update',
        {set: {units: 'in'}},
        {principal: host},
      ),
    ).rejects.toMatchObject({code: 'settings_identity_required'});
    expect(
      (
        (await server.callTool('settings_read', {}, {principal: host})) as {
          values: unknown;
        }
      ).values,
    ).toEqual({units: 'mm', showGrid: false, zoom: 3});
  });

  it('refuses an anonymous update over MCP and returns defaults on read', async () => {
    const {app, server} = await boot();
    await installSettings(app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
    });
    const client = await connect(server, true);
    const upd = await client.callTool({
      name: 'settings_update',
      arguments: {set: {units: 'in'}},
    });
    expect(upd.isError).toBe(true);
    expect(JSON.stringify(upd.content)).toContain('settings_identity_required');
    const read = await client.callTool({name: 'settings_read', arguments: {}});
    expect(read.structuredContent).toMatchObject({
      values: {units: 'mm', showGrid: false, zoom: 3},
    });
  });

  it('supports shared: true and a custom principalKey', async () => {
    const shared = await boot();
    await installSettings(shared.app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
      shared: true,
    });
    await shared.server.callTool('settings_update', {set: {zoom: 5}});
    expect(
      (
        (await shared.server.callTool('settings_read', {})) as {
          values: {zoom: number};
        }
      ).values.zoom,
    ).toBe(5);

    const custom = await boot();
    await installSettings(custom.app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
      principalKey: user =>
        user ? `tenant:${String(user[securityId])}` : undefined,
    });
    const host = authInfoToPrincipals({
      token: 't',
      clientId: 'h',
      scopes: [],
    }).user!;
    await expect(
      custom.server.callTool(
        'settings_update',
        {set: {zoom: 2}},
        {principal: host},
      ),
    ).resolves.toBeDefined();
  });

  it('validates updates against the schema', async () => {
    const {app, server} = await boot();
    await installSettings(app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
    });
    for (const set of [{}, {units: 'cm'}, {zoom: 11}, {other: 1}]) {
      await expect(
        server.callTool('settings_update', {set}, {principal: alice}),
      ).rejects.toThrow();
    }
  });

  it('refuses schemas a settings page cannot render', async () => {
    const {app} = await boot();
    const store = new InMemorySettingsStore();
    await expect(
      installSettings(app, {
        schema: z.object({a: z.string().meta({title: 'A'})}),
        store,
      }),
    ).rejects.toThrow(/needs a \.default\(\)/);
    await expect(
      installSettings(app, {
        schema: z.object({a: z.string().default('x')}),
        store,
      }),
    ).rejects.toThrow(/needs a title/);
    await expect(
      installSettings(app, {
        schema: z.object({
          a: z.array(z.string()).default([]).meta({title: 'A'}),
        }),
        store,
      }),
    ).rejects.toThrow(/boolean, string/);
    await expect(
      installSettings(app, {
        schema: Settings,
        store,
        layout: [
          {
            kind: 'group',
            title: 'G',
            items: [
              {kind: 'property', property: 'units'},
              {kind: 'property', property: 'units'},
            ],
          },
        ],
      }),
    ).rejects.toThrow(/duplicate settings field 'units'/);
  });

  it('checks layout tools at start()', async () => {
    const {app} = await boot();
    await installSettings(app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
      layout: [
        {
          kind: 'group',
          title: 'G',
          items: [{kind: 'tool', tool: 'needs_id', title: 'Go'}],
        },
      ],
    });
    await expect(app.start()).rejects.toThrow(/'needs_id' must accept \{\}/);
  });

  it('retracts both tools and the capability on uninstall', async () => {
    const {app, server} = await boot();
    const installed = await installSettings(app, {
      schema: Settings,
      store: new InMemorySettingsStore(),
    });
    await installed.uninstall();
    expect(server.listTools().map(t => t.meta.name)).toEqual([
      'cad_library',
      'needs_id',
    ]);
    expect(server.advertisedCapabilities()).toEqual({});
    await installed.uninstall(); // idempotent
  });
});
