// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Readable} from 'node:stream';
import {describe, it, expect} from 'vitest';
import {FileNotFoundError, type FileStore} from '../ports.js';

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
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
      await store.put(key, Readable.from([Buffer.from('ab'), Buffer.from('c')]));
      expect((await drain((await store.get(key)).stream)).toString()).toBe('abc');
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
  });
}
