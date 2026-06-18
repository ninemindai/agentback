// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {scanImports} from '../../bundle-doctor.js';

describe('scanImports', () => {
  it('passes a clean graph (nodejs_compat-backed modules allowed)', () => {
    const r = scanImports(['node:crypto', 'node:stream', '@agentback/rest']);
    expect(r.ok).toBe(true);
  });
  it('fails on node:fs and names the culprit', () => {
    const r = scanImports(['node:crypto', 'node:fs/promises']);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/node:fs/);
    expect(r.message).toMatch(/serveStaticDir|AssetSource|filesystem/i);
  });
  it('fails on node:child_process', () => {
    expect(scanImports(['node:child_process']).ok).toBe(false);
  });
});
