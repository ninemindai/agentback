// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Readable} from 'node:stream';
import type {FileStore} from '@agentback/files';
import {serveFile} from '../../file-response.js';

async function drain(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream)
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString();
}

/** Minimal store recording whether get() was asked for a range. */
function fakeStore(
  supportsRange: boolean | undefined,
): Pick<FileStore, 'stat' | 'get' | 'supportsRange'> & {ranged: boolean} {
  const body = '0123456789';
  return {
    supportsRange,
    ranged: false,
    async stat() {
      return {key: 'k', size: body.length, contentType: 'text/plain'};
    },
    async get(_key, opts) {
      this.ranged = !!opts?.range;
      const bytes = opts?.range
        ? body.slice(opts.range.start, (opts.range.end ?? body.length - 1) + 1)
        : body;
      return {
        key: 'k',
        stream: Readable.from(Buffer.from(bytes)),
        size: bytes.length,
        contentType: 'text/plain',
      };
    },
  };
}

describe('serveFile range honesty', () => {
  it('serves 206 + Accept-Ranges when the backend supports ranges', async () => {
    const store = fakeStore(true);
    const res = await serveFile(store, 'k', {range: 'bytes=2-5'});
    expect(res.status).toBe(206);
    expect(res.headers?.['Accept-Ranges']).toBe('bytes');
    expect(res.headers?.['Content-Range']).toBe('bytes 2-5/10');
    expect(store.ranged).toBe(true);
    expect(await drain(res.body as Readable)).toBe('2345');
  });

  it('ignores Range and omits Accept-Ranges when the backend cannot slice', async () => {
    const store = fakeStore(false);
    const res = await serveFile(store, 'k', {range: 'bytes=2-5'});
    expect(res.status).toBeUndefined(); // → route success status (200)
    expect(res.headers?.['Accept-Ranges']).toBeUndefined();
    // Crucially, get() was NOT asked for a range — no throw path on exotic backends.
    expect(store.ranged).toBe(false);
    expect(await drain(res.body as Readable)).toBe('0123456789');
  });

  it('treats an unset supportsRange as supported (built-in adapters)', async () => {
    const store = fakeStore(undefined);
    const res = await serveFile(store, 'k', {range: 'bytes=0-3'});
    expect(res.status).toBe(206);
    expect(res.headers?.['Accept-Ranges']).toBe('bytes');
  });
});
