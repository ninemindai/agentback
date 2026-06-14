// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {
  facets,
  extensionGroups,
  extensionEdges,
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

  it('extensionEdges connects point binding key -> extension key', () => {
    const e = extensionEdges([
      node({key: 'pt', extensionPoint: 'greeters'}),
      node({key: 'e1', extensionFor: ['greeters']}),
      node({key: 'e2', extensionFor: ['greeters', 'other']}),
      // orphan: extends a point with no binding -> dropped
      node({key: 'e3', extensionFor: ['nobody']}),
    ]);
    expect(e).toEqual(
      expect.arrayContaining([
        {from: 'pt', to: 'e1'},
        {from: 'pt', to: 'e2'},
      ]),
    );
    // 'other' and 'nobody' have no point binding -> only the two 'greeters' edges
    expect(e).toHaveLength(2);
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
