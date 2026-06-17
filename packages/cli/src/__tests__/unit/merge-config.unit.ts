// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {mergeVercelConfig} from '../../merge-config.js';

const base = {
  packageManager: 'pnpm',
  includeConsoleAssets: false,
  force: false,
  eject: false,
} as const;

describe('mergeVercelConfig', () => {
  it('writes a fresh canonical config (no hardcoded build/public)', () => {
    const {json} = mergeVercelConfig(undefined, base);
    expect(json.rewrites).toEqual([{source: '/(.*)', destination: '/api'}]);
    expect(json.functions).toBeDefined();
    expect(json).not.toHaveProperty('buildCommand');
    expect(json).not.toHaveProperty('outputDirectory');
  });

  it('adds console includeFiles only when requested', () => {
    const off = mergeVercelConfig(undefined, base).json as any;
    expect(off.functions['api/index.ts'].includeFiles).toBeUndefined();
    const on = mergeVercelConfig(undefined, {
      ...base,
      includeConsoleAssets: true,
    }).json as any;
    expect(on.functions['api/index.ts'].includeFiles).toContain(
      'swagger-ui-dist',
    );
  });

  it('preserves unrelated user keys', () => {
    const {json} = mergeVercelConfig({regions: ['iad1'], headers: []}, base);
    expect(json.regions).toEqual(['iad1']);
    expect(json.headers).toEqual([]);
  });

  it('is idempotent (re-merging its own output changes nothing)', () => {
    const once = mergeVercelConfig(undefined, base).json;
    const twice = mergeVercelConfig(once as any, {...base, force: true}).json;
    expect(twice).toEqual(once);
  });

  it('throws on an existing rewrites array without force/eject', () => {
    expect(() =>
      mergeVercelConfig({rewrites: [{source: '/x', destination: '/y'}]}, base),
    ).toThrow(/rewrites/i);
  });

  it('overwrites rewrites under --force, warning the user', () => {
    const {json, warnings} = mergeVercelConfig(
      {rewrites: [{source: '/x', destination: '/y'}]},
      {...base, force: true},
    );
    expect(json.rewrites).toEqual([{source: '/(.*)', destination: '/api'}]);
    expect(warnings.join(' ')).toMatch(/rewrites/i);
  });
});
