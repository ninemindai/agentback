// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {
  bumpRanges,
  compareVersions,
  detectIndent,
  resolveFromVersion,
  scanAgentbackRanges,
} from '../../update/versions.js';

const PKG = {
  dependencies: {
    '@agentback/core': '^0.9.0',
    '@agentback/rest': '^0.9.0',
    zod: '^4.4.3',
  },
  devDependencies: {'@agentback/testing': '^0.9.0', vitest: '^4.1.0'},
};

describe('scanAgentbackRanges', () => {
  it('collects @agentback/* across dep sections, keyed by section', () => {
    expect([...scanAgentbackRanges(PKG).keys()].sort()).toEqual([
      'dependencies:@agentback/core',
      'dependencies:@agentback/rest',
      'devDependencies:@agentback/testing',
    ]);
  });

  it('keeps both entries when one package is in two sections', () => {
    const r = scanAgentbackRanges({
      dependencies: {'@agentback/core': '^0.9.0'},
      devDependencies: {'@agentback/core': '^0.8.0'},
    });
    expect(r.size).toBe(2);
    expect(resolveFromVersion(r).disagreement).toHaveLength(2);
  });

  it('skips workspace: protocol entries', () => {
    expect(
      scanAgentbackRanges({dependencies: {'@agentback/core': 'workspace:~'}})
        .size,
    ).toBe(0);
  });
});

describe('resolveFromVersion', () => {
  it('resolves the common lockstep version', () => {
    expect(resolveFromVersion(scanAgentbackRanges(PKG))).toEqual({
      version: '0.9.0',
      disagreement: [],
      unparsed: [],
    });
  });

  it('reports disagreement and picks the lowest', () => {
    const r = resolveFromVersion(
      new Map([
        ['dependencies:@agentback/core', '^0.9.0'],
        ['dependencies:@agentback/rest', '^0.8.0'],
      ]),
    );
    expect(r.version).toBe('0.8.0');
    expect(r.disagreement).toHaveLength(2);
  });

  it('records unparseable ranges instead of dropping them', () => {
    const r = resolveFromVersion(
      new Map([
        ['dependencies:@agentback/core', '^0.9.0'],
        ['dependencies:@agentback/rest', 'latest'],
      ]),
    );
    expect(r.version).toBe('0.9.0');
    expect(r.unparsed).toEqual(['dependencies:@agentback/rest']);
  });

  it('throws when no @agentback/* dependency exists', () => {
    expect(() => resolveFromVersion(new Map())).toThrow(/no @agentback/);
  });
});

describe('bumpRanges', () => {
  it('rewrites every @agentback/* entry and reports what changed', () => {
    const {pkg, changed} = bumpRanges(structuredClone(PKG), '0.10.0');
    expect(pkg.dependencies!['@agentback/core']).toBe('^0.10.0');
    expect(pkg.devDependencies!['@agentback/testing']).toBe('^0.10.0');
    expect(pkg.dependencies!.zod).toBe('^4.4.3');
    expect(changed.sort()).toEqual([
      '@agentback/core',
      '@agentback/rest',
      '@agentback/testing',
    ]);
  });

  it('leaves workspace: entries alone', () => {
    expect(
      bumpRanges({dependencies: {'@agentback/core': 'workspace:~'}}, '0.10.0')
        .changed,
    ).toEqual([]);
  });

  it('reports but does not rewrite an unparseable range', () => {
    const {pkg, changed, skipped} = bumpRanges(
      {dependencies: {'@agentback/core': 'latest'}},
      '0.10.0',
    );
    expect(pkg.dependencies!['@agentback/core']).toBe('latest');
    expect(changed).toEqual([]);
    expect(skipped).toEqual(['dependencies:@agentback/core']);
  });
});

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.9.1', '0.9.1')).toBe(0);
  });

  it('orders a prerelease below its release (a hand parser could not)', () => {
    expect(compareVersions('0.10.0-rc.1', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0-rc.2', '0.10.0-rc.1')).toBeGreaterThan(0);
  });
});

describe('detectIndent', () => {
  it('detects 2-space, 4-space, and tab indentation', () => {
    expect(detectIndent('{\n  "a": 1\n}\n')).toBe(2);
    expect(detectIndent('{\n    "a": 1\n}\n')).toBe(4);
    expect(detectIndent('{\n\t"a": 1\n}\n')).toBe('\t');
  });

  it('defaults to 2 for a single-line file', () => {
    expect(detectIndent('{"a":1}')).toBe(2);
  });
});
