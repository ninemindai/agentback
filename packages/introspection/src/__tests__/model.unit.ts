// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {Application} from '@agentback/core';
import {AgentError} from '@agentback/openapi';
import {buildInventory, getNode} from '../model.js';

// A tiny app context with one route and one schema-tagged binding.
const Greeting = z.object({msg: z.string()});

@api({basePath: '/'})
class HelloController {
  @get('/hello', {response: Greeting})
  async hello(): Promise<z.infer<typeof Greeting>> {
    return {msg: 'hi'};
  }
}

function buildCtx(): Application {
  const app = new Application();
  app.controller(HelloController);
  app.bind('secret.token').to('SUPER_SECRET_VALUE');
  return app;
}

describe('buildInventory', () => {
  it('lists binding nodes with metadata only (no values)', () => {
    const nodes = buildInventory(buildCtx(), 'binding');
    const secret = nodes.find(n => n.id === 'secret.token');
    expect(secret).toBeDefined();
    expect(JSON.stringify(nodes)).not.toContain('SUPER_SECRET_VALUE');
  });

  it('filters by kind', () => {
    const all = buildInventory(buildCtx());
    const bindings = buildInventory(buildCtx(), 'binding');
    expect(bindings.every(n => n.kind === 'binding')).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(bindings.length);
  });

  it('surfaces route nodes from the controller (non-binding kind)', () => {
    // buildModel uppercases the verb (model.ts:268).
    const routes = buildInventory(buildCtx(), 'route');
    expect(routes.some(n => n.id === 'GET /hello')).toBe(true);
  });

  it('dedupes (no duplicate kind:id pairs)', () => {
    const all = buildInventory(buildCtx());
    const ids = all.map(n => `${n.kind}:${n.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('getNode', () => {
  it('returns binding metadata without resolving the value', () => {
    const detail = getNode(buildCtx(), {kind: 'binding', id: 'secret.token'});
    expect(JSON.stringify(detail)).not.toContain('SUPER_SECRET_VALUE');
    expect((detail as {key: string}).key).toBe('secret.token');
  });

  it('throws AgentError(404 not_found) for an unknown id', () => {
    expect(() => getNode(buildCtx(), {kind: 'tool', id: 'nope'})).toThrow(
      AgentError,
    );
    try {
      getNode(buildCtx(), {kind: 'tool', id: 'nope'});
    } catch (e) {
      expect((e as AgentError).statusCode).toBe(404);
      expect((e as AgentError).code).toBe('not_found');
    }
  });

  it('returns route detail with the owning binding key', () => {
    // buildModel uppercases the verb (model.ts:268), so the id is "GET /hello".
    const detail = getNode(buildCtx(), {kind: 'route', id: 'GET /hello'}) as {
      verb: string;
      path: string;
      binding: string;
    };
    expect(detail.verb).toBe('GET');
    expect(detail.path).toBe('/hello');
    expect(typeof detail.binding).toBe('string');
  });

  it('returns schema-entity detail by id', () => {
    const entity = buildInventory(buildCtx(), 'schema-entity')[0];
    // Skip if this minimal app surfaced no schema node; otherwise the id must resolve.
    if (entity) {
      const detail = getNode(buildCtx(), {
        kind: 'schema-entity',
        id: entity.id,
      }) as {id: string};
      expect(detail.id).toBe(entity.id);
    }
  });
});
