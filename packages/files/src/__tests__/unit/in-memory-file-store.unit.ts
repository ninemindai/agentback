// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Readable} from 'node:stream';
import {describe, it, expect, beforeEach} from 'vitest';
import {InMemoryFileStore, FileNotFoundError, type FileStore} from '../../index.js';
import {runFileStoreConformance} from '../../testing/conformance.js';

runFileStoreConformance('InMemoryFileStore', () => new InMemoryFileStore());

/** Drain a RetrievedFile's stream back to a Buffer for assertions. */
async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

describe('InMemoryFileStore', () => {
  let store: InMemoryFileStore;
  beforeEach(() => {
    store = new InMemoryFileStore();
  });

  it('round-trips a Buffer with its metadata', async () => {
    const put = await store.put('k1', Buffer.from('hello'), {
      contentType: 'text/plain',
      filename: 'greeting.txt',
      metadata: {owner: 'u1'},
    });
    expect(put).toEqual({key: 'k1', size: 5, contentType: 'text/plain'});

    const got = await store.get('k1');
    expect(got.size).toBe(5);
    expect(got.contentType).toBe('text/plain');
    expect(got.filename).toBe('greeting.txt');
    expect(got.metadata).toEqual({owner: 'u1'});
    expect((await drain(got.stream)).toString()).toBe('hello');
  });

  it('accepts a Readable body and reports the streamed size', async () => {
    const body = Readable.from([Buffer.from('ab'), Buffer.from('cde')]);
    const put = await store.put('k2', body);
    expect(put.size).toBe(5);
    expect((await drain((await store.get('k2')).stream)).toString()).toBe('abcde');
  });

  it('get() throws FileNotFoundError for a missing key', async () => {
    await expect(store.get('nope')).rejects.toBeInstanceOf(FileNotFoundError);
    await expect(store.get('nope')).rejects.toMatchObject({
      code: 'file_not_found',
      key: 'nope',
    });
  });

  it('exists() reflects presence; delete() removes', async () => {
    expect(await store.exists('k3')).toBe(false);
    await store.put('k3', Buffer.from('x'));
    expect(await store.exists('k3')).toBe(true);
    expect(store.count).toBe(1);

    await store.delete('k3');
    expect(await store.exists('k3')).toBe(false);
    expect(store.count).toBe(0);
    // delete of a missing key is a no-op (idempotent)
    await expect(store.delete('k3')).resolves.toBeUndefined();
  });

  it('does not implement the optional presigned hooks', () => {
    const fs: FileStore = store;
    expect(fs.presignedPut).toBeUndefined();
    expect(fs.presignedGet).toBeUndefined();
  });
});
