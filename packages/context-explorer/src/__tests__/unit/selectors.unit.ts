// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {
  facets,
  extensionGroups,
  extensionGraph,
  referenceEdges,
  viewEdges,
  componentMembers,
  configEdges,
  dualByCtor,
} from '../../lib/selectors.js';
import {buildContextTree} from '../../lib/hierarchy.js';
import type {BindingNode, ContextNode} from '../../model.js';

const node = (p: Partial<BindingNode> & {key: string}): BindingNode => ({
  context: p.context ?? 'Application',
  scope: p.scope ?? 'Singleton',
  tags: p.tags ?? [],
  kinds: p.kinds ?? [],
  dependsOn: p.dependsOn ?? [],
  ...p,
});

describe('selectors', () => {
  it('facets counts values per facet', () => {
    const f = facets([
      node({key: 'a', scope: 'Singleton', kinds: ['controller']}),
      node({key: 'b', scope: 'Transient', kinds: ['controller', 'mcpServer']}),
    ]);
    expect(f.scope.get('Singleton')).toBe(1);
    expect(f.scope.get('Transient')).toBe(1);
    expect(f.kind.get('controller')).toBe(2);
    expect(f.kind.get('mcpServer')).toBe(1);
  });

  it('extensionGraph anchors edges on point bindings, synthesizes missing ones', () => {
    const g = extensionGraph([
      node({key: 'pt', extensionPoint: 'greeters'}),
      node({key: 'e1', extensionFor: ['greeters']}),
      node({key: 'e2', extensionFor: ['greeters', 'mcpServers']}),
    ]);
    // 'greeters' has a binding -> edges anchor on 'pt'; 'mcpServers' has no
    // binding -> a synthetic point node + an edge to it.
    // Edges run extension -> point ("extends").
    expect(g.edges).toEqual(
      expect.arrayContaining([
        {from: 'e1', to: 'pt'},
        {from: 'e2', to: 'pt'},
        {from: 'e2', to: 'extension-point:mcpServers'},
      ]),
    );
    expect(g.edges).toHaveLength(3);
    expect(g.points).toEqual([
      {id: 'extension-point:mcpServers', name: 'mcpServers'},
    ]);
  });

  it('referenceEdges links config->target and alias->target', () => {
    const e = referenceEdges([
      node({key: 'application.instance', type: 'Constant'}),
      node({key: 'application.config', type: 'Constant'}),
      node({
        key: 'application.instance:$config',
        type: 'Alias',
        source: 'application.config',
        configurationFor: 'application.instance',
      }),
      // dangling: configures/aliases something not bound -> dropped
      node({
        key: 'x:$config',
        type: 'Alias',
        source: 'gone',
        configurationFor: 'missing',
      }),
    ]);
    expect(e).toEqual(
      expect.arrayContaining([
        {
          from: 'application.instance:$config',
          to: 'application.instance',
          kind: 'config',
        },
        {
          from: 'application.instance:$config',
          to: 'application.config',
          kind: 'alias',
        },
      ]),
    );
    // the dangling config + alias targets are dropped
    expect(e).toHaveLength(2);
  });

  it('viewEdges links a tag-view injector to every binding carrying the tag', () => {
    const e = viewEdges([
      node({key: 'registry', injectsTags: ['lifeCycleObserver']}),
      node({
        key: 'servers.RestServer',
        tags: [{name: 'lifeCycleObserver', value: true}],
      }),
      node({
        key: 'servers.MCPServer',
        tags: [{name: 'lifeCycleObserver', value: true}],
      }),
      node({key: 'unrelated', tags: [{name: 'service', value: true}]}),
    ]);
    expect(e).toEqual(
      expect.arrayContaining([
        {from: 'registry', to: 'servers.RestServer', kind: 'view'},
        {from: 'registry', to: 'servers.MCPServer', kind: 'view'},
      ]),
    );
    expect(e).toHaveLength(2);
  });

  it('componentMembers groups bindings by their fromComponent', () => {
    const m = componentMembers([
      node({key: 'components.X', kinds: ['component']}),
      node({key: 'servers.A', fromComponent: 'components.X'}),
      node({key: 'widget.value', fromComponent: 'components.X'}),
      node({key: 'unowned'}),
    ]);
    expect(m.get('components.X')?.sort()).toEqual([
      'servers.A',
      'widget.value',
    ]);
    expect(m.has('unowned')).toBe(false);
  });

  it('extensionGroups maps point name -> extension keys', () => {
    const g = extensionGroups([
      node({key: 'pt', extensionPoint: 'greeters'}),
      node({key: 'e1', extensionFor: ['greeters']}),
      node({key: 'e2', extensionFor: ['greeters', 'other']}),
    ]);
    expect(
      g
        .get('greeters')
        ?.map(b => b.key)
        .sort(),
    ).toEqual(['e1', 'e2']);
    expect(g.get('other')?.map(b => b.key)).toEqual(['e2']);
  });

  it('configEdges links config binding to its target', () => {
    const e = configEdges([
      node({key: 'cfg', configurationFor: 'servers.RestServer'}),
      node({key: 'servers.RestServer'}),
    ]);
    expect(e.get('servers.RestServer')).toContain('cfg');
  });

  it('dualByCtor groups bindings sharing a source class', () => {
    const d = dualByCtor([
      node({key: 'controllers.X', source: 'X', kinds: ['controller']}),
      node({key: 'services.X', source: 'X', kinds: ['mcpServer']}),
      node({key: 'y', source: 'Y'}),
    ]);
    expect(d.get('X')?.length).toBe(2);
    expect(d.get('Y')?.length).toBe(1);
  });

  it('buildContextTree nests children under parents', () => {
    const contexts: ContextNode[] = [
      {name: 'Application'},
      {name: 'RestServer', parent: 'Application'},
    ];
    const tree = buildContextTree(contexts, [
      node({key: 'a', context: 'Application'}),
      node({key: 'b', context: 'RestServer'}),
    ]);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('Application');
    expect(tree[0].children[0].name).toBe('RestServer');
    expect(tree[0].children[0].bindings.map(b => b.key)).toEqual(['b']);
  });

  it('buildContextTree treats a context with an unknown parent as a root', () => {
    const contexts: ContextNode[] = [
      {name: 'Application'},
      {name: 'Orphaned', parent: 'Missing'},
    ];
    const tree = buildContextTree(contexts, []);
    expect(tree.map(n => n.name).sort()).toEqual(['Application', 'Orphaned']);
    expect(tree.every(n => n.children.length === 0)).toBe(true);
  });

  it('buildContextTree ignores bindings whose context has no node', () => {
    const contexts: ContextNode[] = [{name: 'Application'}];
    const tree = buildContextTree(contexts, [
      node({key: 'a', context: 'Application'}),
      node({key: 'ghost', context: 'Nowhere'}),
    ]);
    expect(tree.length).toBe(1);
    expect(tree[0].bindings.map(b => b.key)).toEqual(['a']);
  });

  it('buildContextTree emits a duplicate-named context exactly once', () => {
    const contexts: ContextNode[] = [
      {name: 'Application'},
      {name: 'Application'},
    ];
    const tree = buildContextTree(contexts, []);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('Application');
  });
});
