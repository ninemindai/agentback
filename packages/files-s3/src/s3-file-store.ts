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
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {
  FileNotFoundError,
  type FileMetadata,
  type FileStore,
  type PresignOptions,
  type PutOptions,
  type RetrievedFile,
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

  async get(key: string): Promise<RetrievedFile> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({Bucket: this.bucket, Key: this.k(key)}),
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
    opts: PutOptions & PresignOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.k(key),
        ...(opts.contentType ? {ContentType: opts.contentType} : {}),
      }),
      {expiresIn: opts.expiresInSec ?? 900},
    );
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
