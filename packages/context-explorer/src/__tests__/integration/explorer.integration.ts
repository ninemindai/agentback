// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {
  Binding,
  BindingScope,
  CoreTags,
  extensionPoint,
  injectable,
} from '@agentback/core';
import {api, get} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {installContextExplorer} from '../../index.js';

const Greeting = z.object({msg: z.string()});

// A REST-only controller.
@api({basePath: '/things'})
class ThingsController {
  @get('/ping', {response: Greeting})
  async ping() {
    return {msg: 'pong'};
  }
}

// An MCP-only tool class.
@mcpServer()
class WeatherServer {
  @tool('forecast', {input: z.object({city: z.string()}), output: Greeting})
  async forecast(_input: {city: string}) {
    return {msg: 'sunny'};
  }
}

// A dual REST+MCP class registered the SINGLE-binding way (restController()).
@api({basePath: '/dual'})
@mcpServer()
class DualOne {
  @get('/hi', {response: Greeting})
  async hi() {
    return {msg: 'hi'};
  }
  @tool('dualTool', {input: z.object({}), output: Greeting})
  async dualTool(_input: Record<string, never>) {
    return {msg: 'tool'};
  }
}

// A dual REST+MCP class registered the TWO-binding way (controller + service).
@api({basePath: '/dual2'})
@mcpServer()
class DualTwo {
  @get('/yo', {response: Greeting})
  async yo() {
    return {msg: 'yo'};
  }
  @tool('dual2Tool', {input: z.object({}), output: Greeting})
  async dual2Tool(_input: Record<string, never>) {
    return {msg: 'tool2'};
  }
}

// A component contributing a binding — its members should be tagged with
// `fromComponent` so the explorer can show what the component contains.
class WidgetComponent {
  bindings = [Binding.bind('widget.value').to(42)];
}

// A provider that throws if instantiated — proves we never resolve.
class ExplodingProvider {
  constructor() {
    throw new Error('must never be resolved');
  }
  value() {
    return 'never';
  }
}

describe('context-explorer model', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.setMetadata({name: 'test-app', version: '9.9.9', description: ''});

    app
      .bind('explorer.test.greeting')
      .to('hi')
      .tag({demo: 'greeting'})
      .inScope(BindingScope.SINGLETON);
    app.bind('explorer.test.transient').to(42).inScope(BindingScope.TRANSIENT);

    // A tag whose value is a class/function: must surface the NAME, not source.
    class TaggedFactory {}
    app.bind('explorer.test.fnTag').to('x').tag({factory: TaggedFactory});

    // A secret + an exploding provider: must never be resolved.
    app.bind('secret.jwt').to('TOP-SECRET').inScope(BindingScope.SINGLETON);
    app.bind('danger.provider').toProvider(ExplodingProvider);

    // Config pattern: configure a (notional) server key.
    app.configure('servers.RestServer').to({port: 0});

    // Extension point + extension (single + multi point to hit array path).
    @extensionPoint('greeters')
    class GreeterPoint {}
    @injectable({tags: {[CoreTags.EXTENSION_FOR]: 'greeters'}})
    class EnglishGreeter {}
    @injectable({tags: {[CoreTags.EXTENSION_FOR]: ['greeters', 'salutations']}})
    class MultiGreeter {}
    app.service(GreeterPoint);
    app.service(EnglishGreeter);
    app.service(MultiGreeter);

    app.restController(ThingsController);
    app.service(WeatherServer);
    app.restController(DualOne); // single binding: REST + MCP
    app.controller(DualTwo); // two bindings...
    app.service(DualTwo); // ...same class
    app.component(WidgetComponent);

    await installContextExplorer(app, {title: 'Test Explorer'});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterEach(async () => app.stop());

  const getModel = async () =>
    (await client.get('/context-explorer/api/model').expect(200)).body as {
      app: {name?: string; version?: string};
      contexts: {name: string; parent?: string}[];
      bindings: {
        key: string;
        scope: string;
        type?: string;
        tags: {name: string; value: string | boolean}[];
        kinds: string[];
        dependsOn: string[];
        extensionPoint?: string;
        extensionFor?: string[];
        configurationFor?: string;
        fromComponent?: string;
        routes?: {verb: string; path: string}[];
        tools?: {name: string}[];
      }[];
    };

  const find = (m: Awaited<ReturnType<typeof getModel>>, key: string) =>
    m.bindings.find(b => b.key === key)!;

  it('returns scope, type and TAG VALUES (not just names)', async () => {
    const m = await getModel();
    const g = find(m, 'explorer.test.greeting');
    expect(g.scope).toBe(BindingScope.SINGLETON);
    expect(g.tags).toEqual(
      expect.arrayContaining([{name: 'demo', value: 'greeting'}]),
    );
    expect(find(m, 'explorer.test.transient').scope).toBe(
      BindingScope.TRANSIENT,
    );
  });

  it('renders a class/function tag value as its name, not its source', async () => {
    const m = await getModel();
    const fnTag = find(m, 'explorer.test.fnTag').tags.find(
      t => t.name === 'factory',
    );
    expect(fnTag).toEqual({name: 'factory', value: 'TaggedFactory'});
  });

  it('reports the application identity from APPLICATION_METADATA', async () => {
    const m = await getModel();
    expect(m.app.name).toBe('test-app');
    expect(m.app.version).toBe('9.9.9');
  });

  it('exposes the context hierarchy', async () => {
    const m = await getModel();
    expect(m.contexts.length).toBeGreaterThan(0);
    expect(m.contexts.some(c => c.parent === undefined)).toBe(true);
  });

  it('computes dependsOn for direct-key injections', async () => {
    const m = await getModel();
    // The explorer controller injects the application instance.
    const ctrl = m.bindings.find(b =>
      b.dependsOn.includes('application.instance'),
    );
    expect(ctrl).toBeDefined();
  });

  it('detects controller and mcpServer kinds + extension wiring', async () => {
    const m = await getModel();
    expect(find(m, 'controllers.ThingsController').kinds).toContain(
      'controller',
    );
    // GreeterPoint is an extension point; EnglishGreeter extends it.
    const point = m.bindings.find(b => b.extensionPoint === 'greeters');
    expect(point).toBeDefined();
    const multi = m.bindings.find(
      b => b.extensionFor && b.extensionFor.includes('salutations'),
    )!;
    // Array extensionFor normalized to string[].
    expect(multi.extensionFor).toEqual(
      expect.arrayContaining(['greeters', 'salutations']),
    );
  });

  it('marks config bindings with configurationFor', async () => {
    const m = await getModel();
    const cfg = m.bindings.find(b => b.configurationFor != null);
    expect(cfg).toBeDefined();
    expect(cfg!.kinds).toContain('config');
  });

  it('tags component-contributed bindings with fromComponent', async () => {
    const m = await getModel();
    const widget = find(m, 'widget.value');
    expect(widget.fromComponent).toBe('components.WidgetComponent');
    // and the component is discoverable as the contributor
    const comp = find(m, 'components.WidgetComponent');
    expect(comp.kinds).toContain('component');
  });

  it('dual via restController() is ONE node with both kinds, routes AND tools', async () => {
    const m = await getModel();
    const node = find(m, 'controllers.DualOne');
    expect(node.kinds).toEqual(
      expect.arrayContaining(['controller', 'mcpServer']),
    );
    expect(node.routes?.some(r => r.path.includes('/dual'))).toBe(true);
    expect(node.tools?.some(t => t.name === 'dualTool')).toBe(true);
  });

  it('dual via controller()+service() is TWO nodes sharing a source class', async () => {
    const m = await getModel();
    const dualTwoNodes = m.bindings.filter(
      b => (b as {source?: string}).source === 'DualTwo',
    );
    expect(dualTwoNodes.length).toBe(2);
    const kinds = new Set(dualTwoNodes.flatMap(b => b.kinds));
    expect(kinds.has('controller')).toBe(true);
    expect(kinds.has('mcpServer')).toBe(true);
  });

  it('never resolves a binding (secret + exploding provider untouched)', async () => {
    const m = await getModel();
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain('TOP-SECRET');
    // If buildModel resolved danger.provider, beforeEach/start would throw.
    expect(find(m, 'danger.provider').type).toBe('Provider');
  });

  it('removed /bindings and /graph', async () => {
    await client.get('/context-explorer/api/bindings').expect(404);
    await client.get('/context-explorer/api/graph').expect(404);
  });

  it('keeps the raw /inspect passthrough and serves the shell', async () => {
    const r = await client.get('/context-explorer/api/inspect').expect(200);
    expect(r.body.bindings).toBeTypeOf('object');
    const html = await client.get('/context-explorer/').expect(200);
    expect(html.text).toMatch(/<title>Test Explorer<\/title>/);
  });
});
