// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Readable} from 'node:stream';

/**
 * A contiguous byte range to read, mirroring the HTTP `Range` header
 * (`bytes=start-end`). Both bounds are **0-based** and `end` is **inclusive** —
 * `{start: 0, end: 99}` is the first 100 bytes (not slice() semantics). Omit
 * `end` to read from `start` to the end of the object (`bytes=start-`).
 */
export interface ByteRange {
  /** First byte to return, 0-based and inclusive. */
  start: number;
  /** Last byte to return, 0-based and inclusive. Omit to read to EOF. */
  end?: number;
}

/** Options accepted when reading a file. */
export interface GetOptions {
  /**
   * Return only this contiguous slice instead of the whole object — the
   * building block for video seeking and resumable downloads. The returned
   * {@link RetrievedFile}'s `size` is the slice length, and `stream` carries
   * only those bytes. An adapter whose backend has no range primitive throws
   * rather than silently returning the whole object.
   */
  range?: ByteRange;
}

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

/**
 * Metadata about a stored object, without its bytes — the result of a HEAD, not
 * a GET. Returned by {@link FileStore.stat}.
 */
export interface FileMetadata {
  key: string;
  size: number;
  contentType?: string;
  /** Original filename, when one was recorded on `put`. */
  filename?: string;
  /** Backend entity tag (e.g. S3 ETag), when the adapter provides one. */
  etag?: string;
  /** Last-modified time, when the adapter tracks one. */
  lastModified?: Date;
  /** Arbitrary string metadata persisted with the object. */
  metadata?: Record<string, string>;
}

/** A retrieved file: a readable byte stream plus the metadata stored with it. */
export interface RetrievedFile extends FileMetadata {
  stream: Readable;
}

/** Options for the optional presigned-URL hooks. */
export interface PresignOptions {
  /** URL lifetime in seconds. Adapter chooses a default when omitted. */
  expiresInSec?: number;
}

/** Extra controls for a presigned upload (direct-to-storage). */
export interface PresignPutOptions extends PutOptions, PresignOptions {
  /**
   * Maximum upload size in bytes, enforced by the storage backend. When set, an
   * adapter that can enforce it (S3/R2 via a presigned POST policy) returns a
   * `POST`-form {@link SignedUpload}; an adapter that cannot enforce a size cap
   * throws rather than handing back an unbounded URL. **Strongly recommended**
   * for any client-facing upload — without it, anyone holding the URL can
   * upload an arbitrarily large object until it expires.
   */
  maxSize?: number;
  /**
   * Minimum upload size in bytes for the size-enforced (POST) policy. Defaults
   * to `1` (reject empty uploads) when {@link maxSize} is set. Pass `0` to allow
   * empty uploads. Ignored when `maxSize` is absent.
   */
  minSize?: number;
}

/**
 * A presigned direct-to-storage upload.
 *
 * - `PUT` — a single signed URL the client PUTs the bytes to, optionally with
 *   the given request `headers`. Simple, but the size is **unbounded**.
 * - `POST` — an HTML-form upload (S3/R2 presigned POST) whose `fields` carry
 *   the signed policy. The only form that can enforce a server-side size limit
 *   (see {@link PresignPutOptions.maxSize}); the client must send `fields`
 *   followed by the file as `multipart/form-data`.
 */
export type SignedUpload =
  | {method: 'PUT'; url: string; headers?: Record<string, string>}
  | {method: 'POST'; url: string; fields: Record<string, string>};

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
  get(key: string, opts?: GetOptions): Promise<RetrievedFile>;
  /**
   * Metadata for `key` without transferring the body — a HEAD, not a GET.
   * Throws {@link FileNotFoundError} for a missing key. Prefer it over
   * {@link get} when the caller only needs size/contentType/etag (a file-info
   * endpoint, a conditional request, setting `Content-Length` before a
   * redirect) — on a remote store this avoids fetching the bytes.
   */
  stat(key: string): Promise<FileMetadata>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /**
   * Whether `get(key, {range})` honors byte ranges. Consumers like `serveFile`
   * advertise `Accept-Ranges` and serve `206` only when this is not `false`
   * (unset is treated as supported, matching the built-in adapters). An adapter
   * over a backend with no range primitive sets it `false` so range support is
   * never advertised falsely.
   */
  readonly supportsRange?: boolean;
  presignedPut?(key: string, opts?: PresignPutOptions): Promise<SignedUpload>;
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
