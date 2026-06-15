// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, describe, expect, it} from 'vitest';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FsFileStore} from '../../index.js';
import {runFileStoreConformance} from '../../testing/conformance.js';

const root = mkdtempSync(join(tmpdir(), 'agentback-fs-'));
afterAll(() => rmSync(root, {recursive: true, force: true}));

// Runs unconditionally (no external service needed) — unlike the S3 adapter.
runFileStoreConformance('FsFileStore', () => new FsFileStore({baseDir: root}));

describe('FsFileStore specifics', () => {
  it('writes the bytes to disk under baseDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentback-fs-spec-'));
    const store = new FsFileStore({baseDir: dir});
    await store.put('k1', Buffer.from('on disk'), {contentType: 'text/plain'});
    expect(existsSync(join(dir, 'k1'))).toBe(true);
    expect(readFileSync(join(dir, 'k1'), 'utf8')).toBe('on disk');
    rmSync(dir, {recursive: true, force: true});
  });

  it('delete removes both the data and its metadata sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentback-fs-spec-'));
    const store = new FsFileStore({baseDir: dir});
    await store.put('k2', Buffer.from('x'), {filename: 'x.bin'});
    expect(existsSync(join(dir, 'k2.meta.json'))).toBe(true);
    await store.delete('k2');
    expect(existsSync(join(dir, 'k2'))).toBe(false);
    expect(existsSync(join(dir, 'k2.meta.json'))).toBe(false);
    rmSync(dir, {recursive: true, force: true});
  });

  it('rejects a key that escapes the base directory', async () => {
    const store = new FsFileStore({baseDir: root});
    await expect(store.put('../escape', Buffer.from('no'))).rejects.toThrow(
      /escapes the base directory/,
    );
  });
});
