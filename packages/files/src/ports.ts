// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Readable} from 'node:stream';

/** Options accepted when storing a file. */
export interface PutOptions {
  /** MIME type recorded alongside the bytes (echoed on `get`). */
  contentType?: string;
  /** Original filename, surfaced on download as `Content-Disposition`. */
  filename?: string;
  /** Arbitrary string metadata persisted with the object. */
  metadata?: Record<string, string>;
}

/** Result of a successful {@link FileStore.put}. */
export interface StoredFile {
  key: string;
  size: number;
  contentType?: string;
  /** Backend entity tag (e.g. S3 ETag), when the adapter provides one. */
  etag?: string;
}

/** A retrieved file: a readable byte stream plus the metadata stored with it. */
export interface RetrievedFile {
  key: string;
  stream: Readable;
  size: number;
  contentType?: string;
  filename?: string;
  metadata?: Record<string, string>;
}

/** Options for the optional presigned-URL hooks. */
export interface PresignOptions {
  /** URL lifetime in seconds. Adapter chooses a default when omitted. */
  expiresInSec?: number;
}

/**
 * Transport-agnostic file storage seam. Adapters (in-memory, S3, …) implement
 * it; REST handlers stream uploads in via {@link put} and downloads out via
 * {@link get}. Bind an implementation at {@link FILE_STORE} and inject it.
 *
 * Keys are opaque to the store — callers MUST generate them server-side (e.g. a
 * UUID); never pass a client-controlled path, or an S3 adapter is open to
 * key-traversal. `get` throws {@link FileNotFoundError} for a missing key.
 *
 * `presignedPut`/`presignedGet` are optional: a server-proxied adapter omits
 * them; a direct-to-storage adapter implements them. They are declared here so
 * a future presigned flow is an additive capability, not a breaking change.
 */
export interface FileStore {
  put(
    key: string,
    body: Readable | Buffer,
    opts?: PutOptions,
  ): Promise<StoredFile>;
  get(key: string): Promise<RetrievedFile>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  presignedPut?(key: string, opts?: PutOptions & PresignOptions): Promise<string>;
  presignedGet?(key: string, opts?: PresignOptions): Promise<string>;
}

/**
 * Thrown by {@link FileStore.get} when no object exists at the key. The REST
 * layer maps this to a 404 (it stays here so the port carries no HTTP/openapi
 * dependency).
 */
export class FileNotFoundError extends Error {
  readonly code = 'file_not_found';
  constructor(readonly key: string) {
    super(`No file stored at key '${key}'.`);
    this.name = 'FileNotFoundError';
  }
}
