// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {sortByGraph} from '../../graph.js';
import type {PluginInfo} from '../../types.js';

function info(
  name: string,
  provides: string[] = [],
  inject: string[] = [],
): PluginInfo {
  return {
    name,
    version: '1.0.0',
    component: 'C',
    source: 'deps',
    path: `/x/${name}`,
    importSpecifier: name,
    provides,
    inject,
  };
}

const EMPTY = {
  skipped: [] as PluginInfo[],
  appOwnedKeys: new Set<string>(),
  order: [] as string[],
  allowOverride: new Set<string>(),
};

describe('sortByGraph', () => {
  it('derives order from inject -> provides, against discovery order', () => {
    const consumer = info('consumer', [], ['services.Db']);
    const provider = info('provider', ['services.Db']);
    // Discovery order is deliberately WRONG (consumer first).
    const r = sortByGraph({...EMPTY, gated: [consumer, provider]});
    expect(r.errors).toEqual([]);
    expect(r.ordered.map(p => p.name)).toEqual(['provider', 'consumer']);
  });

  it('an app-bound key satisfies an inject and adds NO edge', () => {
    const consumer = info('consumer', [], ['services.Db']);
    const other = info('other');
    const r = sortByGraph({
      ...EMPTY,
      gated: [consumer, other],
      appOwnedKeys: new Set(['services.Db']),
    });
    expect(r.errors).toEqual([]);
    // No edge means discovery order is preserved.
    expect(r.ordered.map(p => p.name)).toEqual(['consumer', 'other']);
  });

  it('with zero declarations, order: fully governs (back-compat)', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a'), info('b'), info('c')],
      order: ['c', 'b'],
    });
    expect(r.ordered.map(p => p.name)).toEqual(['c', 'b', 'a']);
  });

  it('order: breaks ties only among simultaneously-ready plugins', () => {
    const provider = info('provider', ['services.Db']);
    const consumer = info('consumer', [], ['services.Db']);
    const loner = info('loner');
    // order: asks for consumer first, but the edge outranks it.
    const r = sortByGraph({
      ...EMPTY,
      gated: [provider, consumer, loner],
      order: ['consumer', 'loner'],
    });
    expect(r.ordered.map(p => p.name)).toEqual([
      'loner',
      'provider',
      'consumer',
    ]);
  });

  it('reports an unsatisfiable inject', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', [], ['services.Gone'])],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe('unsatisfied-inject');
    expect(r.errors[0].package).toBe('a');
    expect(r.errors[0].message).toContain('services.Gone');
  });

  it('names the gate when the provider was discovered but skipped', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', [], ['services.Db'])],
      skipped: [info('provider', ['services.Db'])],
    });
    expect(r.errors[0].kind).toBe('unsatisfied-inject');
    expect(r.errors[0].message).toContain('provider');
  });

  it('reports a cycle naming BOTH plugins', () => {
    const a = info('a', ['services.A'], ['services.B']);
    const b = info('b', ['services.B'], ['services.A']);
    const r = sortByGraph({...EMPTY, gated: [a, b]});
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe('dependency-cycle');
    expect(r.errors[0].message).toContain('a');
    expect(r.errors[0].message).toContain('b');
    expect(r.ordered).toEqual([]);
  });

  it('reports duplicate provides before any import', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', ['services.X']), info('b', ['services.X'])],
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].kind).toBe('duplicate-provides');
    expect(r.errors[0].collidingKeys).toEqual(['services.X']);
  });

  it('allows duplicate provides when allowOverride lists the key', () => {
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('a', ['services.X']), info('b', ['services.X'])],
      allowOverride: new Set(['services.X']),
    });
    expect(r.errors).toEqual([]);
    expect(r.ordered).toHaveLength(2);
  });

  it('an under-declared inject still mounts (advisory, not enforced)', () => {
    // 'consumer' really needs services.Db but never declared it.
    const r = sortByGraph({
      ...EMPTY,
      gated: [info('consumer'), info('provider', ['services.Db'])],
    });
    expect(r.errors).toEqual([]);
    expect(r.ordered).toHaveLength(2);
  });
});
