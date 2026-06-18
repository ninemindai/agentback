// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {runBundleDoctor} from '../../bundle-doctor.js';

describe('runBundleDoctor (real esbuild)', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bundle-doctor-'));
  });

  afterAll(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it(
    'returns ok:false and names node:fs when entry imports node:fs',
    async () => {
      const entry = join(tmpDir, 'entry-fs.ts');
      writeFileSync(
        entry,
        `import {readFileSync} from 'node:fs'; export const x = readFileSync;`,
      );
      const result = await runBundleDoctor(entry);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/node:fs/);
    },
    20_000,
  );

  it(
    'returns ok:true for an entry that only imports node:crypto (allowed)',
    async () => {
      const entry = join(tmpDir, 'entry-crypto.ts');
      writeFileSync(
        entry,
        `import {randomUUID} from 'node:crypto'; export const y = randomUUID;`,
      );
      const result = await runBundleDoctor(entry);
      expect(result.ok).toBe(true);
    },
    20_000,
  );

  it(
    'returns ok:false with compile-failed message for a syntax error entry',
    async () => {
      const entry = join(tmpDir, 'entry-syntax.ts');
      writeFileSync(entry, `export const broken = {{{;`);
      const result = await runBundleDoctor(entry);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Worker bundle failed to compile/);
    },
    20_000,
  );
});
