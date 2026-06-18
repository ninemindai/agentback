// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {runBundleDoctor} from '../../bundle-doctor.js';

// When compiled, this file lives at:
//   packages/cli/dist/__tests__/integration/bundle-doctor.integration.js
// Two levels up is packages/cli/dist, which has access to @agentback/rest via
// the package's node_modules symlink. Entries that import @agentback/rest must
// be written under this directory so esbuild's Node module resolution can find
// the package.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/__tests__/integration → dist
const cliDist = resolve(__dirname, '../..');

describe('runBundleDoctor (real esbuild)', () => {
  let tmpDir: string;
  // Separate temp dir for entries that need @agentback/rest resolution.
  // Must be INSIDE the CLI package tree so esbuild can walk up to find
  // packages/cli/node_modules/@agentback/rest.
  let restTmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bundle-doctor-'));
    restTmpDir = mkdtempSync(join(cliDist, '.bundle-doctor-rest-'));
  });

  afterAll(() => {
    rmSync(tmpDir, {recursive: true, force: true});
    rmSync(restTmpDir, {recursive: true, force: true});
  });

  it('returns ok:false and names node:fs when entry imports node:fs', async () => {
    const entry = join(tmpDir, 'entry-fs.ts');
    writeFileSync(
      entry,
      `import {readFileSync} from 'node:fs'; export const x = readFileSync;`,
    );
    const result = await runBundleDoctor(entry);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/node:fs/);
  }, 20_000);

  it('returns ok:true for an entry that only imports node:crypto (allowed)', async () => {
    const entry = join(tmpDir, 'entry-crypto.ts');
    writeFileSync(
      entry,
      `import {randomUUID} from 'node:crypto'; export const y = randomUUID;`,
    );
    const result = await runBundleDoctor(entry);
    expect(result.ok).toBe(true);
  }, 20_000);

  it('returns ok:false with compile-failed message for a syntax error entry', async () => {
    const entry = join(tmpDir, 'entry-syntax.ts');
    writeFileSync(entry, `export const broken = {{{;`);
    const result = await runBundleDoctor(entry);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Worker bundle failed to compile/);
  }, 20_000);

  // ── nodejs_compat allow-list fixes ────────────────────────────────────────

  it('returns ok:true for an entry that only imports node:path (now allowed)', async () => {
    const entry = join(tmpDir, 'entry-path.ts');
    writeFileSync(
      entry,
      `import {join} from 'node:path'; export const x = join;`,
    );
    const result = await runBundleDoctor(entry);
    expect(result.ok).toBe(true);
  }, 20_000);

  it('returns ok:false naming node:fs for an entry that imports bare fs (CJS shim)', async () => {
    // Write a tiny CJS module that does require('fs') by bare name.
    const shimPath = join(tmpDir, 'bare-fs-shim.cjs');
    writeFileSync(
      shimPath,
      `'use strict'; const fs = require('fs'); module.exports = fs;`,
    );
    const entry = join(tmpDir, 'entry-bare-fs.ts');
    writeFileSync(
      entry,
      // Import the CJS shim so esbuild bundles it and records the bare 'fs'
      // external in the metafile outputs.imports.
      `import shim from './bare-fs-shim.cjs'; export const y = shim;`,
    );
    const result = await runBundleDoctor(entry);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/node:fs/);
  }, 20_000);

  // ── Framework tree-shaking tests ──────────────────────────────────────────
  // These tests use the real @agentback/rest package to prove the doctor is
  // tree-shaking-aware: it must NOT false-positive on workers that only use
  // the edge-compatible fetch path (where node:fs is dead code), and MUST
  // flag workers that actually reach fromDisk / serveStaticDir.

  it('Entry A — @agentback/rest fetch-only path → ok:true (node:fs tree-shaken)', async () => {
    const entry = join(restTmpDir, 'entry-rest-fetch.ts');
    // Import only the edge-safe createFetchHost — does NOT pull in fromDisk
    // or asset-source-disk.ts, so node:fs is dead code and tree-shaken away.
    writeFileSync(
      entry,
      [
        `import {createFetchHost} from '@agentback/rest';`,
        `const host = createFetchHost({`,
        `  router: {match: () => null} as any,`,
        `  dispatch: () => Promise.resolve(new Response('ok')),`,
        `});`,
        `export default host;`,
      ].join('\n'),
    );
    const result = await runBundleDoctor(entry);
    expect(result.ok).toBe(true);
  }, 30_000);

  it('Entry B — @agentback/rest fromDisk usage → ok:false naming node:fs', async () => {
    const entry = join(restTmpDir, 'entry-rest-disk.ts');
    // Explicitly imports fromDisk, which lives in asset-source-disk.ts and
    // transitively pulls in node:fs/promises and node:path. The doctor must
    // report the denied import.
    writeFileSync(
      entry,
      [
        `import {fromDisk} from '@agentback/rest';`,
        `export const assetSource = fromDisk('/public');`,
      ].join('\n'),
    );
    const result = await runBundleDoctor(entry);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/node:fs/);
  }, 30_000);
});
