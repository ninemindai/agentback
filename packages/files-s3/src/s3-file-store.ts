// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Readable} from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {Upload} from '@aws-sdk/lib-storage';
import {createPresignedPost} from '@aws-sdk/s3-presigned-post';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
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

export interface S3FileStoreOptions {
  /** Target bucket. */
  bucket: string;
  /** Reuse an existing client, or… */
  client?: S3Client;
  /** …construct one from this config (region, endpoint, credentials, …). */
  clientConfig?: S3ClientConfig;
  /** Optional key prefix namespacing every object (e.g. `'uploads/'`). */
  keyPrefix?: string;
}

/**
 * S3-backed {@link FileStore}. Streams uploads via `@aws-sdk/lib-storage`'s
 * `Upload` (no full-file buffering) and streams downloads from `GetObject`,
 * recording `filename` in object metadata. Ports the dapp5 `s3.service`
 * recipe onto the framework port. Also implements the optional presigned-URL
 * hooks for a direct-to-S3 flow.
 */
export class S3FileStore implements FileStore {
  readonly supportsRange = true;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3FileStoreOptions) {
    this.client = opts.client ?? new S3Client(opts.clientConfig ?? {});
    this.bucket = opts.bucket;
    this.prefix = opts.keyPrefix ?? '';
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async put(
    key: string,
    body: Readable | Buffer,
    opts: PutOptions = {},
  ): Promise<StoredFile> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: this.k(key),
        Body: body,
        ...(opts.contentType ? {ContentType: opts.contentType} : {}),
        Metadata: {
          ...(opts.filename ? {filename: opts.filename} : {}),
          ...(opts.metadata ?? {}),
        },
      },
    });
    const res = await upload.done();
    // lib-storage doesn't return the stored size; a HEAD is the reliable source.
    const head = await this.client.send(
      new HeadObjectCommand({Bucket: this.bucket, Key: this.k(key)}),
    );
    return {
      key,
      size: head.ContentLength ?? 0,
      contentType: head.ContentType,
      etag: (res as {ETag?: string}).ETag ?? head.ETag,
    };
  }

  async get(key: string, opts: GetOptions = {}): Promise<RetrievedFile> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.k(key),
          // S3 honors the HTTP Range header and replies 206 with the slice;
          // `ContentLength` then reflects the slice length, not the full object.
          ...(opts.range
            ? {Range: `bytes=${opts.range.start}-${opts.range.end ?? ''}`}
            : {}),
        }),
      );
      return {
        key,
        stream: res.Body as Readable,
        size: res.ContentLength ?? 0,
        contentType: res.ContentType,
        filename: res.Metadata?.filename,
        metadata: res.Metadata,
      };
    } catch (err) {
      if (isNotFound(err)) throw new FileNotFoundError(key);
      throw err;
    }
  }

  async stat(key: string): Promise<FileMetadata> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({Bucket: this.bucket, Key: this.k(key)}),
      );
      return {
        key,
        size: head.ContentLength ?? 0,
        contentType: head.ContentType,
        filename: head.Metadata?.filename,
        etag: head.ETag,
        lastModified: head.LastModified,
        metadata: head.Metadata,
      };
    } catch (err) {
      if (isNotFound(err)) throw new FileNotFoundError(key);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({Bucket: this.bucket, Key: this.k(key)}),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({Bucket: this.bucket, Key: this.k(key)}),
    );
  }

  async presignedPut(
    key: string,
    opts: PresignPutOptions = {},
  ): Promise<SignedUpload> {
    const expiresIn = opts.expiresInSec ?? 900;
    // A size cap can only be enforced by a presigned POST policy
    // (`content-length-range`); a plain PUT URL is unbounded.
    if (opts.maxSize != null) {
      const {url, fields} = await createPresignedPost(this.client, {
        Bucket: this.bucket,
        Key: this.k(key),
        Conditions: [['content-length-range', opts.minSize ?? 1, opts.maxSize]],
        ...(opts.contentType
          ? {Fields: {'Content-Type': opts.contentType}}
          : {}),
        Expires: expiresIn,
      });
      return {method: 'POST', url, fields};
    }
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        ...(opts.contentType ? {ContentType: opts.contentType} : {}),
      }),
      {expiresIn},
    );
    return {
      method: 'PUT',
      url,
      ...(opts.contentType
        ? {headers: {'Content-Type': opts.contentType}}
        : {}),
    };
  }

  async presignedGet(key: string, opts: PresignOptions = {}): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({Bucket: this.bucket, Key: this.k(key)}),
      {expiresIn: opts.expiresInSec ?? 900},
    );
  }
}

/** S3 "not found" across GetObject (NoSuchKey) and HeadObject (NotFound/404). */
function isNotFound(err: unknown): boolean {
  const e = err as {name?: string; $metadata?: {httpStatusCode?: number}};
  return (
    e?.name === 'NoSuchKey' ||
    e?.name === 'NotFound' ||
    e?.$metadata?.httpStatusCode === 404
  );
}
