// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {extensionFor} from '@agentback/core';
import {RestApplication, REST_CONTROLLER_TAG} from '@agentback/rest';
import {api, post, get, bindSchema} from '@agentback/openapi';
import {mcpServer, tool, MCP_SERVERS} from '@agentback/mcp';
import {installSchemaExplorer} from '../../index.js';
import type {SchemaNode} from '../../inventory.js';

// One shared entity, reused as a REST response, an MCP tool output, AND
// registered with a table origin — the whole point: object identity collapses
// all three into a single node.
const Widget = z.object({id: z.number(), name: z.string()});
// A second shape used only as input on both surfaces — never registered, so it
// must still appear (discovered) with a synthesized name and no origin.
const NewWidget = z.object({name: z.string()});

@api({basePath: '/widgets'})
@mcpServer()
class WidgetController {
  @post('/', {body: NewWidget, response: Widget, status: 201})
  async create(input: {
    body: z.infer<typeof NewWidget>;
  }): Promise<z.infer<typeof Widget>> {
    return {id: 1, name: input.body.name};
  }

  @get('/all', {response: z.array(Widget)})
  async all(): Promise<z.infer<typeof Widget>[]> {
    return [];
  }

  @tool('create_widget', {input: NewWidget, output: Widget})
  async createWidget(
    input: z.infer<typeof NewWidget>,
  ): Promise<z.infer<typeof Widget>> {
    return {id: 1, name: input.name};
  }
}

describe('schema-explorer', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    // One binding, both surfaces: restController tag + MCP_SERVERS extension.
    app
      .bind('controllers.WidgetController')
      .toClass(WidgetController)
      .tag(REST_CONTROLLER_TAG)
      .apply(extensionFor(MCP_SERVERS));
    // Register the shared entity with a (pretend) table origin.
    bindSchema(app, 'Widget', Widget, {table: 'widgets', kind: 'select'});
    await installSchemaExplorer(app, {title: 'Test Schemas'});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterEach(async () => app.stop());

  const find = (nodes: SchemaNode[], name: string) =>
    nodes.find(n => n.name === name);

  it('joins a shared schema across REST + MCP into one registered node', async () => {
    const r = await client.get('/schema-explorer/api/schemas').expect(200);
    const nodes = r.body as SchemaNode[];

    const widget = find(nodes, 'Widget');
    expect(widget).toBeDefined();
    expect(widget!.bound).toBe(true);
    expect(widget!.origin?.table).toBe('widgets');
    expect(widget!.origin?.kind).toBe('select');

    // The same Widget object is the POST response, the GET /all (array) is a
    // distinct object so it does NOT collapse here; assert the two direct uses.
    const refs = widget!.usages.map(u => `${u.surface}:${u.role}:${u.ref}`);
    expect(refs).toContain('rest:response:POST /widgets');
    expect(refs).toContain('mcp:output:create_widget');
    // Exactly one node carries the Widget identity (no duplicate).
    expect(nodes.filter(n => n.origin?.table === 'widgets')).toHaveLength(1);
  });

  it('discovers an unregistered shared input schema with a synthesized name', async () => {
    const r = await client.get('/schema-explorer/api/schemas').expect(200);
    const nodes = r.body as SchemaNode[];

    // NewWidget is used by POST body + tool input; it was never registered, so
    // it has no binding but must still be one node with both usages.
    const newWidget = nodes.find(
      n =>
        !n.bound &&
        n.usages.some(u => u.surface === 'rest' && u.role === 'body') &&
        n.usages.some(u => u.surface === 'mcp' && u.role === 'input'),
    );
    expect(newWidget).toBeDefined();
    expect(newWidget!.bound).toBe(false);
    expect(newWidget!.origin).toBeUndefined();
    expect(newWidget!.name.length).toBeGreaterThan(0);
  });

  it('emits a provenance graph of schema -> surface edges', async () => {
    const r = await client.get('/schema-explorer/api/graph').expect(200);
    const {nodes, surfaces, edges} = r.body as {
      nodes: SchemaNode[];
      surfaces: {id: string; surface: string; ref: string}[];
      edges: {from: string; to: string; role: string; surface: string}[];
    };

    // The POST route and the MCP tool both surface.
    expect(surfaces.some(s => s.ref === 'POST /widgets')).toBe(true);
    expect(surfaces.some(s => s.ref === 'create_widget')).toBe(true);

    // Every edge connects a real schema node to a real surface node.
    const nodeIds = new Set(nodes.map(n => n.id));
    const surfaceIds = new Set(surfaces.map(s => s.id));
    for (const e of edges) {
      expect(nodeIds.has(e.from)).toBe(true);
      expect(surfaceIds.has(e.to)).toBe(true);
    }
  });

  it('serves the HTML shell and the esbuild bundle', async () => {
    const html = await client.get('/schema-explorer').expect(200);
    expect(html.headers['content-type']).toMatch(/text\/html/);
    expect(html.text).toMatch(/<title>Test Schemas<\/title>/);
    expect(html.text).toMatch(/\/schema-explorer\/assets\/main\.js/);

    const js = await client.get('/schema-explorer/assets/main.js').expect(200);
    expect(js.headers['content-type']).toMatch(
      /application\/javascript|text\/javascript/,
    );
  });
});
