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
    // The fixtures dir deliberately contains `marker-typo`, whose bad key is
    // reported. Everything else scans clean.
    expect(warnings.filter(w => !w.includes('marker-typo'))).toEqual([]);
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
    const dir = await resolvePackageDir('@agentback/core', import.meta.url);
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

describe('readMarker — provides/inject', () => {
  it('normalizes a missing provides/inject to empty arrays', () => {
    const info = readMarker(resolve(fixtures, 'good-plugin'), 'dir');
    expect(info?.provides).toEqual([]);
    expect(info?.inject).toEqual([]);
  });

  it('reads declared provides and inject', () => {
    const provider = readMarker(resolve(fixtures, 'graph-provider'), 'dir');
    expect(provider?.provides).toEqual(['services.Shared']);
    expect(provider?.inject).toEqual([]);

    const consumer = readMarker(resolve(fixtures, 'graph-consumer'), 'dir');
    expect(consumer?.inject).toEqual(['services.Shared']);
  });

  it('drops a malformed provides without failing discovery', () => {
    // A marker field is caller-authored JSON; a non-array must not be fatal.
    const info = readMarker(resolve(fixtures, 'graph-malformed'), 'dir');
    expect(info).not.toBeNull();
    expect(info?.provides).toEqual([]);
  });
});

describe('readMarker — typo detection', () => {
  it('warns on an unrecognized marker key instead of dropping it silently', () => {
    // `provide` for `provides` still mounts, so a silent drop leaves the
    // author debugging an ordering problem with no visible cause.
    const warnings: string[] = [];
    const info = readMarker(
      resolve(fixtures, 'marker-typo'),
      'dir',
      undefined,
      warnings,
    );
    expect(info).not.toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"provide"');
    expect(warnings[0]).toContain('provides');
  });

  it('says nothing when every marker key is recognized', () => {
    const warnings: string[] = [];
    readMarker(resolve(fixtures, 'graph-provider'), 'dir', undefined, warnings);
    expect(warnings).toEqual([]);
  });
});
