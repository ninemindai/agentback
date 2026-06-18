// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/mit/

/**
 * BARREL bundle-clean proof:
 * `import {loggers} from '@agentback/common'` (the barrel — exactly what
 * @agentback/rest imports) must NOT pull dotenv / node:fs / node:path /
 * node:module into the static import graph of an esbuild `platform:browser`
 * bundle.
 *
 * The test uses esbuild's --metafile to inspect the reachable import graph.
 * String literals that appear inside function bodies (e.g., the dynamic
 * require('dotenv') inside loadEnvFiles()) are intentional — they are never
 * called on non-Node runtimes because of the Node guard — and do not
 * constitute a static dependency.
 */

import {describe, it, expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function findEsbuild(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'esbuild');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('esbuild binary not found');
}

describe('BARREL edge-safety: import {loggers} from @agentback/common', () => {
  it('esbuild platform:browser metafile graph has no dotenv/fs/path/module static imports', () => {
    const esbuild = findEsbuild();

    // import.meta.dirname is dist/__tests__/unit/
    // 3 levels up → packages/common/
    let pkgRoot = import.meta.dirname;
    for (let i = 0; i < 3; i++) pkgRoot = path.dirname(pkgRoot);
    // pkgRoot is now packages/common/

    // The barrel entry point (dist/index.js) — exactly what rest.server.ts resolves
    const barrelEntry = path.join(pkgRoot, 'dist', 'index.js');

    // Write a tiny entry file that does exactly what rest.server.ts does
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barrel-test-'));
    const entryFile = path.join(tmpDir, 'entry.mjs');
    fs.writeFileSync(
      entryFile,
      `import {loggers} from ${JSON.stringify(barrelEntry)};\nconsole.log(loggers);\n`,
    );

    const outFile = path.join(tmpDir, 'bundle.js');
    const metaFile = path.join(tmpDir, 'meta.json');

    try {
      // Build must succeed with platform:browser and node:* external
      execFileSync(
        esbuild,
        [
          entryFile,
          '--bundle',
          '--platform=browser',
          `--outfile=${outFile}`,
          `--metafile=${metaFile}`,
          '--external:debug',
          '--external:node:*',
          '--external:util', // non-prefixed node builtin alias
          '--external:path',
          '--external:fs',
          '--external:os',
          '--external:crypto',
        ],
        {encoding: 'utf8', stdio: 'pipe'},
      );

      // --- Check metafile static import graph for banned modules -------
      // These must NOT appear as static imports — if dotenv/node:fs/node:path
      // appeared here it would mean esbuild statically resolved them through
      // the module graph (the bug we fixed).
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

      const reachableImports: string[] = [];
      for (const output of Object.values(
        meta.outputs as Record<string, {imports?: {path: string}[]}>
      )) {
        if (output.imports) {
          for (const imp of output.imports) {
            reachableImports.push(imp.path);
          }
        }
      }

      // Report the graph for visibility in test output
      console.log(
        'BARREL metafile graph (reachable imports):\n ',
        reachableImports.join('\n  '),
      );

      // None of these must appear as static imports in the graph
      const banned = ['dotenv', 'node:fs', 'node:path', 'node:module'];
      for (const mod of banned) {
        const found = reachableImports.filter(p => p === mod || p.startsWith(mod + '/'));
        expect(
          found,
          `static import graph must NOT contain "${mod}" — found: ${JSON.stringify(found)}`,
        ).toHaveLength(0);
      }
    } finally {
      fs.rmSync(tmpDir, {recursive: true, force: true});
    }
  });
});
