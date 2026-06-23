// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Readable} from 'node:stream';
import {
  type ByteRange,
  FileNotFoundError,
  type FileMetadata,
  type FileStore,
  type GetOptions,
  type PutOptions,
  type RetrievedFile,
  type StoredFile,
} from '../ports.js';

interface Entry {
  buffer: Buffer;
  contentType?: string;
  filename?: string;
  metadata?: Record<string, string>;
}

/**
 * In-memory {@link FileStore} for tests and local dev. Each object is buffered
 * whole in a `Map`, so it is NOT for production — no streaming-to-disk and no
 * size cap (a large upload is held in memory). Use an `S3FileStore` (or similar
 * streaming adapter) in production.
 */
export class InMemoryFileStore implements FileStore {
  readonly supportsRange = true;
  private readonly store = new Map<string, Entry>();

  async put(
    key: string,
    body: Readable | Buffer,
    opts: PutOptions = {},
  ): Promise<StoredFile> {
    const buffer = await toBuffer(body);
    this.store.set(key, {
      buffer,
      contentType: opts.contentType,
      filename: opts.filename,
      metadata: opts.metadata,
    });
    return {key, size: buffer.byteLength, contentType: opts.contentType};
  }

  async get(key: string, opts: GetOptions = {}): Promise<RetrievedFile> {
    const e = this.store.get(key);
    if (!e) throw new FileNotFoundError(key);
    const buffer = opts.range ? sliceRange(e.buffer, opts.range) : e.buffer;
    return {
      key,
      stream: Readable.from(buffer),
      size: buffer.byteLength,
      contentType: e.contentType,
      filename: e.filename,
      metadata: e.metadata,
    };
  }

  async stat(key: string): Promise<FileMetadata> {
    const e = this.store.get(key);
    if (!e) throw new FileNotFoundError(key);
    return {
      key,
      size: e.buffer.byteLength,
      contentType: e.contentType,
      filename: e.filename,
      metadata: e.metadata,
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Test helper: number of stored objects. */
  get count(): number {
    return this.store.size;
  }
}

/** Slice a buffer to a {@link ByteRange} (0-based, `end` inclusive), clamped to bounds. */
function sliceRange(buf: Buffer, {start, end}: ByteRange): Buffer {
  const from = Math.max(0, start);
  const to = end != null ? Math.min(buf.byteLength, end + 1) : buf.byteLength;
  return buf.subarray(from, Math.max(from, to));
}

/** Collect a Buffer or a Readable into a single Buffer. */
async function toBuffer(body: Readable | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}
