// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Readable} from 'node:stream';
import {describe, it, expect} from 'vitest';
import {FileNotFoundError, type FileStore} from '../ports.js';

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream)
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

let n = 0;
/** A unique key per call so a shared backing bucket stays collision-free. */
function uniqueKey(tag: string): string {
  return `agentback-conformance/${tag}-${process.pid}-${++n}`;
}

/**
 * The {@link FileStore} contract, as a reusable suite. Every adapter
 * (in-memory, S3, …) runs it to prove it honors the port. `makeStore` returns
 * a fresh (or shared) store; keys are unique per assertion so a real bucket is
 * safe.
 */
export function runFileStoreConformance(
  label: string,
  makeStore: () => FileStore | Promise<FileStore>,
): void {
  describe(`FileStore conformance: ${label}`, () => {
    it('put → get round-trips bytes, contentType, size', async () => {
      const store = await makeStore();
      const key = uniqueKey('roundtrip');
      const put = await store.put(key, Buffer.from('payload'), {
        contentType: 'application/octet-stream',
        filename: 'p.bin',
      });
      expect(put.size).toBe(7);
      const got = await store.get(key);
      expect((await drain(got.stream)).toString()).toBe('payload');
      expect(got.contentType).toBe('application/octet-stream');
      expect(got.size).toBe(7);
      await store.delete(key);
    });

    it('accepts a Readable body', async () => {
      const store = await makeStore();
      const key = uniqueKey('stream');
      await store.put(
        key,
        Readable.from([Buffer.from('ab'), Buffer.from('c')]),
      );
      expect((await drain((await store.get(key)).stream)).toString()).toBe(
        'abc',
      );
      await store.delete(key);
    });

    it('get with a byte range returns only the slice', async () => {
      const store = await makeStore();
      const key = uniqueKey('range');
      await store.put(key, Buffer.from('0123456789'));
      const slice = await store.get(key, {range: {start: 2, end: 5}});
      expect(slice.size).toBe(4);
      expect((await drain(slice.stream)).toString()).toBe('2345');
      // open-ended range reads to EOF
      const tail = await store.get(key, {range: {start: 7}});
      expect((await drain(tail.stream)).toString()).toBe('789');
      await store.delete(key);
    });

    it('exists reflects presence; delete removes', async () => {
      const store = await makeStore();
      const key = uniqueKey('lifecycle');
      expect(await store.exists(key)).toBe(false);
      await store.put(key, Buffer.from('x'));
      expect(await store.exists(key)).toBe(true);
      await store.delete(key);
      expect(await store.exists(key)).toBe(false);
    });

    it('get of a missing key throws FileNotFoundError', async () => {
      const store = await makeStore();
      await expect(store.get(uniqueKey('missing'))).rejects.toBeInstanceOf(
        FileNotFoundError,
      );
    });

    it('stat returns metadata (no body); missing throws FileNotFoundError', async () => {
      const store = await makeStore();
      const key = uniqueKey('stat');
      await store.put(key, Buffer.from('1234'), {
        contentType: 'text/plain',
        filename: 's.txt',
      });
      const md = await store.stat(key);
      expect(md.key).toBe(key);
      expect(md.size).toBe(4);
      expect(md.contentType).toBe('text/plain');
      expect(md.filename).toBe('s.txt');
      // stat is metadata-only — it must not carry a byte stream.
      expect((md as {stream?: unknown}).stream).toBeUndefined();
      await store.delete(key);
      await expect(
        store.stat(uniqueKey('stat-missing')),
      ).rejects.toBeInstanceOf(FileNotFoundError);
    });
  });
}
