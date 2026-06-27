// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fs} from 'files-sdk/fs';
import {runFileStoreConformance} from '@agentback/files/testing';
import {FilesSdkFileStore} from '../../files-sdk-file-store.js';

const root = mkdtempSync(join(tmpdir(), 'agentback-files-sdk-'));
afterAll(() => rmSync(root, {recursive: true, force: true}));

// Runs unconditionally against the filesystem adapter — no external service,
// no credentials — so the bridge is proven end-to-end in CI.
runFileStoreConformance(
  'FilesSdk(fs)',
  () => new FilesSdkFileStore({adapter: fs({root})}),
);

describe('FilesSdkFileStore specifics', () => {
  it('round-trips filename + metadata through the backend', async () => {
    const store = new FilesSdkFileStore({adapter: fs({root})});
    await store.put('with-meta', Buffer.from('hi'), {
      filename: 'original.txt',
      metadata: {owner: 'alice'},
    });
    const got = await store.get('with-meta');
    expect(got.filename).toBe('original.txt');
    expect(got.metadata?.owner).toBe('alice');
  });

  it('omits presign hooks on a backend without a signing primitive', () => {
    const store = new FilesSdkFileStore({adapter: fs({root})});
    expect(store.presignedGet).toBeUndefined();
    expect(store.presignedPut).toBeUndefined();
  });

  it('applies the key prefix', async () => {
    const store = new FilesSdkFileStore({
      adapter: fs({root}),
      prefix: 'tenant-a/',
    });
    await store.put('doc', Buffer.from('scoped'));
    expect(await store.exists('doc')).toBe(true);
  });
});
