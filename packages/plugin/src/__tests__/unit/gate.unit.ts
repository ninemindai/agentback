// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {applyGate} from '../../gate.js';
import {PluginsConfig} from '../../config.js';
import type {PluginInfo} from '../../types.js';

function info(name: string): PluginInfo {
  return {
    name,
    version: '1.0.0',
    component: 'C',
    source: 'deps',
    path: `/x/${name}`,
    importSpecifier: name,
  };
}

const A = info('a');
const B = info('b');
const C = info('c');

describe('applyGate', () => {
  it('mounts everything in discovery order by default', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({}));
    expect(r.ordered.map(p => p.name)).toEqual(['a', 'b', 'c']);
    expect(r.skipped).toEqual([]);
  });

  it('enable acts as an allowlist', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({enable: ['a', 'c']}));
    expect(r.ordered.map(p => p.name)).toEqual(['a', 'c']);
    expect(r.skipped.map(p => p.name)).toEqual(['b']);
    expect(r.skipped[0].reason).toBe('not-enabled');
  });

  it('disable subtracts after enable', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({disable: ['b']}));
    expect(r.ordered.map(p => p.name)).toEqual(['a', 'c']);
    expect(r.skipped.map(p => p.name)).toEqual(['b']);
    expect(r.skipped[0].reason).toBe('disabled');
  });

  it('order prefixes, remainder keeps discovery order', () => {
    const r = applyGate([A, B, C], PluginsConfig.parse({order: ['c']}));
    expect(r.ordered.map(p => p.name)).toEqual(['c', 'a', 'b']);
  });

  it('warns when enable names an undiscovered package', () => {
    const r = applyGate([A], PluginsConfig.parse({enable: ['a', 'ghost']}));
    expect(r.warnings.join(' ')).toMatch(/ghost/);
  });
});
