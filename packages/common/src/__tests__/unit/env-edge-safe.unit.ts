// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Bundle-clean proof: importing `loggers` from @agentback/common must NOT pull
 * `dotenv`, `node:fs`, or `node:path` into a Workers/browser bundle.
 *
 * This test shells out to esbuild with platform:'browser' and checks that the
 * resulting bundle contains none of the Node-only primitives.
 */

import {describe, it, expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// Resolve esbuild binary relative to this test's dist location:
// dist/__tests__/unit/ → ../../.. → dist/ → ../../../../node_modules
function findEsbuild(): string {
  // Walk up from __dirname to the workspace root and look for esbuild
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'esbuild');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('esbuild binary not found');
}

describe('edge-safety: loggers bundle must not contain dotenv/fs', () => {
  it('esbuild platform:browser bundle of loggers has no dotenv/node:fs references', () => {
    const esbuild = findEsbuild();

    // import.meta.dirname is dist/__tests__/unit/
    // Going up 3 levels reaches the package root (packages/common/)
    let pkgRoot = import.meta.dirname;
    for (let i = 0; i < 3; i++) pkgRoot = path.dirname(pkgRoot);
    // Now pkgRoot is packages/common/

    const entryPoint = path.join(pkgRoot, 'dist', 'utils', 'debug-factory.js');

    const outFile = path.join(os.tmpdir(), `loggers-bundle-${Date.now()}.js`);

    try {
      // Mark node: built-ins and the `debug` npm package as external so esbuild
      // doesn't try to polyfill them — the test only cares that `dotenv` and
      // `node:fs`/`node:path`/`node:module` are NOT reachable from this entry
      // point, not that the bundle is fully runnable in a browser.
      execFileSync(
        esbuild,
        [
          entryPoint,
          '--bundle',
          '--platform=browser',
          `--outfile=${outFile}`,
          '--external:debug',
          '--external:node:*',
          '--external:util', // util is also a node built-in (non-prefixed alias)
        ],
        {encoding: 'utf8', stdio: 'pipe'},
      );

      const bundle = fs.readFileSync(outFile, 'utf8');

      // These strings must NOT appear in a Workers-safe bundle
      expect(bundle, 'bundle must not reference dotenv').not.toContain(
        'dotenv',
      );
      expect(
        bundle,
        'bundle must not reference readFileSync',
      ).not.toContain('readFileSync');
      expect(bundle, 'bundle must not reference node:fs').not.toContain(
        'node:fs',
      );
    } finally {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    }
  });
});
