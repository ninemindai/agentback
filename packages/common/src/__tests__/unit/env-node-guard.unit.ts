// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Regression test for the edge-runtime guard in loadEnvFiles. The key case is
 * Cloudflare's `nodejs_compat`, which FAKES `process.versions.node` — so the
 * guard must ALSO require a `file:` `import.meta.url` before resolving Node
 * builtins, or a worker crashes at startup (createRequire(undefined)).
 */

import {describe, it, expect} from 'vitest';
import {hasNodeFileSystem} from '../../utils/env-node.js';

describe('hasNodeFileSystem (edge-runtime guard)', () => {
  it('true on real Node: versions.node set + file: import.meta.url', () => {
    expect(
      hasNodeFileSystem({versions: {node: '22.13.0'}}, 'file:///app/x.js'),
    ).toBe(true);
  });

  it('false when process is absent (browser)', () => {
    expect(hasNodeFileSystem(undefined, 'file:///app/x.js')).toBe(false);
  });

  it('false when versions.node is missing', () => {
    expect(hasNodeFileSystem({versions: {}}, 'file:///app/x.js')).toBe(false);
  });

  it('false on Workers: nodejs_compat fakes versions.node but import.meta.url is undefined', () => {
    // This is the exact shape that crashed the worker before the fix.
    expect(hasNodeFileSystem({versions: {node: '22.13.0'}}, undefined)).toBe(
      false,
    );
  });

  it('false when import.meta.url is not a file: URL', () => {
    expect(
      hasNodeFileSystem({versions: {node: '22.13.0'}}, 'https://x/y.js'),
    ).toBe(false);
  });
});
