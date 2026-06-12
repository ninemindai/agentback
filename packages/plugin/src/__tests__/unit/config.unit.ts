// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {PluginsConfig} from '../../config.js';

describe('PluginsConfig', () => {
  it('applies safe defaults when empty', () => {
    expect(PluginsConfig.parse(undefined)).toEqual({
      scan: true,
      dirs: [],
      disable: [],
      order: [],
      allowOverride: [],
      strict: true,
    });
  });

  it('keeps enable optional (undefined means "mount all")', () => {
    const parsed = PluginsConfig.parse({});
    expect(parsed.enable).toBeUndefined();
  });

  it('preserves explicit values', () => {
    const parsed = PluginsConfig.parse({
      scan: false,
      dirs: ['./plugins'],
      enable: ['@acme/foo'],
      disable: ['@acme/bar'],
      order: ['@acme/foo'],
      allowOverride: ['services.X'],
      strict: false,
    });
    expect(parsed.scan).toBe(false);
    expect(parsed.dirs).toEqual(['./plugins']);
    expect(parsed.enable).toEqual(['@acme/foo']);
    expect(parsed.strict).toBe(false);
  });
});
