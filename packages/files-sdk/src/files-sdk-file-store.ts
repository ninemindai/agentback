// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Readable} from 'node:stream';
import {Files, FilesError} from 'files-sdk';
import type {Adapter, Body} from 'files-sdk';
import {
  FileNotFoundError,
  type FileMetadata,
  type FileStore,
  type GetOptions,
  type PresignOptions,
  type PresignPutOptions,
  type PutOptions,
  type RetrievedFile,
  type SignedUpload,
  type StoredFile,
} from '@agentback/files';

/** Metadata key the adapter reserves to round-trip the original filename. */
const FILENAME_META_KEY = 'filename';
/** Presigned-URL default lifetime, mirroring the `@agentback/files-s3` adapter. */
const DEFAULT_EXPIRES_IN_SEC = 900;

export interface FilesSdkFileStoreOptions {
  /**
   * Any `files-sdk` adapter — `fs(...)`, `s3(...)`, `r2(...)`, `gcs(...)`, … —
   * the variable part this store delegates to. Construct it from the matching
   * `files-sdk/<provider>` subpath and hand it in.
   */
  adapter: Adapter;
  /** Optional key prefix namespacing every object (e.g. `'uploads/'`). */
  prefix?: string;
}

/**
 * A {@link FileStore} backed by [`files-sdk`](https://files-sdk.dev) — one port
 * over 40+ storage backends. Wraps the SDK's server-side {@link Files} client:
 * REST/MCP handlers keep declaring `fileField()` / `fileResponse(...)`, and the
 * concrete backend (S3, R2, GCS, Azure, filesystem, …) is a one-line adapter
 * swap in `files-sdk` terms.
 *
 * **The I/O seam is the only real bridge.** A Node `Buffer` is already a
 * `Uint8Array`, so it is a valid `files-sdk` `Body` unchanged; a Node
 * `Readable` is converted with `Readable.toWeb()` on the way in and
 * `Readable.fromWeb()` on the way out. Keeping the conversion isolated here is
 * what lets the same store run edge-native later (where the bytes are already
 * Web streams).
 *
 * **Presign is capability-gated.** `presignedGet`/`presignedPut` are present
 * only when the underlying adapter advertises a signing primitive
 * (`files.capabilities.signedUrl.supported`) — so they exist on an S3/R2 store
 * and are absent on the filesystem one, matching the port's "optional means
 * unsupported" contract exactly.
 */
export class FilesSdkFileStore implements FileStore {
  private readonly files: Files;

  presignedGet?: (key: string, opts?: PresignOptions) => Promise<string>;
  presignedPut?: (
    key: string,
    opts?: PresignPutOptions,
  ) => Promise<SignedUpload>;

  constructor(opts: FilesSdkFileStoreOptions) {
    this.files = new Files({adapter: opts.adapter, prefix: opts.prefix});
    // Only expose the presign hooks the backend can actually honor — otherwise
    // they stay `undefined`, which the REST layer reads as "no direct flow".
    if (this.files.capabilities.signedUrl.supported) {
      this.presignedGet = (key, presign) =>
        this.files.url(key, {
          expiresIn: presign?.expiresInSec ?? DEFAULT_EXPIRES_IN_SEC,
        });
      // files-sdk's SignedUpload is structurally identical to the port's, and
      // it picks PUT vs size-enforced POST from `maxSize` for us.
      this.presignedPut = (key, presign) =>
        this.files.signedUploadUrl(key, {
          expiresIn: presign?.expiresInSec ?? DEFAULT_EXPIRES_IN_SEC,
          ...(presign?.contentType ? {contentType: presign.contentType} : {}),
          ...(presign?.maxSize != null ? {maxSize: presign.maxSize} : {}),
          ...(presign?.minSize != null ? {minSize: presign.minSize} : {}),
        });
    }
  }

  async put(
    key: string,
    body: Readable | Buffer,
    opts: PutOptions = {},
  ): Promise<StoredFile> {
    const metadata = {
      ...(opts.filename ? {[FILENAME_META_KEY]: opts.filename} : {}),
      ...(opts.metadata ?? {}),
    };
    const res = await this.files.upload(key, toBody(body), {
      ...(opts.contentType ? {contentType: opts.contentType} : {}),
      // Skip metadata entirely on backends without a user-metadata primitive —
      // passing it would throw. `filename` round-trip is best-effort there.
      ...(this.files.capabilities.metadata && Object.keys(metadata).length
        ? {metadata}
        : {}),
    });
    return {
      key,
      size: res.size,
      contentType: res.contentType,
      ...(res.etag ? {etag: res.etag} : {}),
    };
  }

  async get(key: string, opts: GetOptions = {}): Promise<RetrievedFile> {
    if (opts.range && !this.files.capabilities.rangeRead) {
      throw new Error(
        'FilesSdkFileStore.get: the underlying files-sdk backend has no ' +
          'byte-range primitive (capabilities.rangeRead is false).',
      );
    }
    try {
      const sf = await this.files.download(
        key,
        opts.range
          ? {range: {start: opts.range.start, end: opts.range.end}}
          : {},
      );
      return {
        key,
        stream: Readable.fromWeb(sf.stream()),
        size: sf.size,
        contentType: sf.type,
        ...(sf.metadata?.[FILENAME_META_KEY]
          ? {filename: sf.metadata[FILENAME_META_KEY]}
          : {}),
        ...(sf.metadata ? {metadata: sf.metadata} : {}),
      };
    } catch (err) {
      if (isNotFound(err)) throw new FileNotFoundError(key);
      throw err;
    }
  }

  async stat(key: string): Promise<FileMetadata> {
    try {
      // `head` fetches metadata only — the returned StoredFile's body
      // accessors would lazily GET, but we never touch them here.
      const sf = await this.files.head(key);
      return {
        key,
        size: sf.size,
        contentType: sf.type,
        ...(sf.metadata?.[FILENAME_META_KEY]
          ? {filename: sf.metadata[FILENAME_META_KEY]}
          : {}),
        ...(sf.etag ? {etag: sf.etag} : {}),
        ...(sf.lastModified != null
          ? {lastModified: new Date(sf.lastModified)}
          : {}),
        ...(sf.metadata ? {metadata: sf.metadata} : {}),
      };
    } catch (err) {
      if (isNotFound(err)) throw new FileNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    return this.files.exists(key);
  }

  async delete(key: string): Promise<void> {
    try {
      await this.files.delete(key);
    } catch (err) {
      // Keep delete idempotent: a missing key is already in the desired state.
      if (isNotFound(err)) return;
      throw err;
    }
  }
}

/**
 * Bridge a Node body to a `files-sdk` {@link Body}. A `Buffer` is a
 * `Uint8Array`, so it passes through; a `Readable` becomes a Web
 * `ReadableStream` via the Node 22 interop.
 */
function toBody(body: Readable | Buffer): Body {
  if (Buffer.isBuffer(body)) return body;
  // `Readable.toWeb` returns a `ReadableStream<any>`; the byte streams we feed
  // it carry `Uint8Array` chunks, which is the `Body` shape files-sdk expects.
  return Readable.toWeb(body) as ReadableStream<Uint8Array>;
}

/** A `files-sdk` "object does not exist" failure, however it surfaced. */
function isNotFound(err: unknown): boolean {
  return err instanceof FilesError && err.code === 'NotFound';
}
