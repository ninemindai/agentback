// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  discoverFromDirs,
  readMarker,
  resolvePackageDir,
} from '../../discovery.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/__tests__/unit -> package root -> fixtures
const fixtures = resolve(here, '../../../fixtures');

describe('readMarker', () => {
  it('reads a marked package off disk', () => {
    const info = readMarker(resolve(fixtures, 'good-plugin'), 'dir');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('@fixture/good-plugin');
    expect(info!.version).toBe('1.2.3');
    expect(info!.component).toBe('GoodComponent');
    expect(info!.source).toBe('dir');
  });

  it('returns null for an unmarked package', () => {
    expect(readMarker(resolve(fixtures, 'unmarked'), 'dir')).toBeNull();
  });

  it('returns null for a non-existent dir', () => {
    expect(readMarker(resolve(fixtures, 'does-not-exist'), 'dir')).toBeNull();
  });
});

describe('discoverFromDirs', () => {
  it('scans a dir and finds marked subpackages', () => {
    const warnings: string[] = [];
    const found = discoverFromDirs([fixtures], fixtures, warnings);
    expect(found.map(p => p.name)).toContain('@fixture/good-plugin');
    expect(warnings).toEqual([]);
  });

  it('warns and continues when a configured dir is missing', () => {
    const warnings: string[] = [];
    const found = discoverFromDirs(
      [resolve(fixtures, 'no-such-dir')],
      fixtures,
      warnings,
    );
    expect(found).toEqual([]);
    expect(warnings.join(' ')).toMatch(
      /no-such-dir.*missing or not a directory/,
    );
  });
});

describe('resolvePackageDir (ESM exports-map regression)', () => {
  it('finds a package dir for a restrictive-exports dependency without ERR_PACKAGE_PATH_NOT_EXPORTED', async () => {
    const dir = await resolvePackageDir(
      '@agentback/core',
      import.meta.url,
    );
    expect(dir).not.toBeNull();
    // Built indirectly so the test bundler (Vite) does not statically
    // pre-resolve and crash before the test runs; the runtime import still
    // rejects with ERR_PACKAGE_PATH_NOT_EXPORTED against the restrictive
    // exports map, which is the behavior under regression.
    const naiveSubpath = '@agentback/core' + '/package.json';
    await expect(
      import(/* @vite-ignore */ naiveSubpath, {with: {type: 'json'}}),
    ).rejects.toThrow();
  });
});
