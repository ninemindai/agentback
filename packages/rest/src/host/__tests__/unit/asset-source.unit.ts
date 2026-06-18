// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {fromDisk} from '../../asset-source.js';

describe('fromDisk', () => {
  let dir: string;
  beforeEach(() => {dir = mkdtempSync(path.join(tmpdir(), 'asset-'));});
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  it('serves an existing file with a content-type', async () => {
    writeFileSync(path.join(dir, 'main.js'), 'console.log(1)');
    const res = await fromDisk(dir)('/main.js');
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('javascript');
  });

  it('returns undefined for a missing file', async () => {
    expect(await fromDisk(dir)('/nope.js')).toBeUndefined();
  });

  it('rejects path traversal', async () => {
    expect(await fromDisk(dir)('/../secret')).toBeUndefined();
  });
});
