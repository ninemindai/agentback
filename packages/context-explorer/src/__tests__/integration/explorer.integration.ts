// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {BindingScope} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {installContextExplorer} from '../../index.js';

describe('context-explorer', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    // Seed a couple of distinctive bindings to assert against.
    app
      .bind('explorer.test.greeting')
      .to('hi')
      .tag('demo', 'greeting')
      .inScope(BindingScope.SINGLETON);
    app.bind('explorer.test.transient').to(42).inScope(BindingScope.TRANSIENT);
    await installContextExplorer(app, {title: 'Test Explorer'});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterEach(async () => app.stop());

  it('lists bindings with scope and tags at /context-explorer/api/bindings', async () => {
    const r = await client.get('/context-explorer/api/bindings').expect(200);
    expect(Array.isArray(r.body)).toBe(true);
    const greeting = r.body.find(
      (b: {key: string}) => b.key === 'explorer.test.greeting',
    );
    expect(greeting).toBeDefined();
    expect(greeting.scope).toBe(BindingScope.SINGLETON);
    expect(greeting.tags).toEqual(expect.arrayContaining(['demo', 'greeting']));
    const transient = r.body.find(
      (b: {key: string}) => b.key === 'explorer.test.transient',
    );
    expect(transient.scope).toBe(BindingScope.TRANSIENT);
  });

  it('returns the nested inspect tree of bindings', async () => {
    const r = await client.get('/context-explorer/api/inspect').expect(200);
    expect(r.body.bindings).toBeTypeOf('object');
    expect(r.body.bindings['explorer.test.greeting']).toBeDefined();
  });

  // The boolean query flag is exercised via `includeInjections`, which is
  // observable on a root app: the explorer controller has a constructor
  // @inject, so its binding carries an `injections` entry when (and only when)
  // injections are requested. This also proves `?flag=false` is honoured
  // (not coerced to true).
  it('includes injection metadata by default and omits it on includeInjections=false', async () => {
    const hasAnyInjections = (tree: {bindings: Record<string, unknown>}) =>
      Object.values(tree.bindings).some(
        b => (b as {injections?: unknown}).injections !== undefined,
      );

    const withInj = await client
      .get('/context-explorer/api/inspect')
      .expect(200);
    expect(hasAnyInjections(withInj.body)).toBe(true);

    const withoutInj = await client
      .get('/context-explorer/api/inspect?includeInjections=false')
      .expect(200);
    expect(hasAnyInjections(withoutInj.body)).toBe(false);
  });

  it('exposes a dependency graph at /graph with clean edges', async () => {
    const r = await client.get('/context-explorer/api/graph').expect(200);
    const keys: string[] = r.body.nodes.map((n: {key: string}) => n.key);
    expect(keys).toContain('explorer.test.greeting');

    // The explorer controller injects the application instance, so there is at
    // least one real dependency edge pointing at it.
    type Edge = {from: string; to: string};
    expect(
      (r.body.edges as Edge[]).some(e => e.to === 'application.instance'),
    ).toBe(true);

    // Edges are well-formed: no self-edges, both endpoints are known nodes.
    const nodeSet = new Set(keys);
    for (const e of r.body.edges as Edge[]) {
      expect(e.from).not.toBe(e.to);
      expect(nodeSet.has(e.from)).toBe(true);
      expect(nodeSet.has(e.to)).toBe(true);
    }
  });

  it('serves the HTML shell at /context-explorer and /context-explorer/', async () => {
    for (const path of ['/context-explorer', '/context-explorer/']) {
      const r = await client.get(path).expect(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.text).toMatch(/<title>Test Explorer<\/title>/);
      expect(r.text).toMatch(/<div id="root">/);
      expect(r.text).toMatch(/\/context-explorer\/assets\/main\.js/);
    }
  });

  it('serves the esbuild bundle at /context-explorer/assets/main.js', async () => {
    const r = await client.get('/context-explorer/assets/main.js').expect(200);
    expect(r.headers['content-type']).toMatch(
      /application\/javascript|text\/javascript/,
    );
  });
});
