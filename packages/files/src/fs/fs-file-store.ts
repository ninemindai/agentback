// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createReadStream, createWriteStream} from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rm,
  stat as fsStat,
  writeFile,
} from 'node:fs/promises';
import {dirname, resolve, sep} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
  FileNotFoundError,
  type FileMetadata,
  type FileStore,
  type PutOptions,
  type RetrievedFile,
  type StoredFile,
} from '../ports.js';

/** Per-object metadata persisted next to the bytes as `<key>.meta.json`. */
interface Sidecar {
  contentType?: string;
  filename?: string;
  metadata?: Record<string, string>;
}

export interface FsFileStoreOptions {
  /** Directory under which all objects live. Created on demand. */
  baseDir: string;
  /** Optional key prefix (a subdirectory) namespacing every object. */
  keyPrefix?: string;
}

/**
 * Local-filesystem {@link FileStore}. Streams object bytes to/from
 * `<baseDir>/<key>` and keeps a small `<key>.meta.json` sidecar for
 * contentType/filename/metadata. Good for single-node deploys, self-hosting,
 * and dev-with-persistence — between {@link InMemoryFileStore} and an
 * `S3FileStore`.
 *
 * Every key is resolved under `baseDir` and rejected if it escapes (defense in
 * depth — REST keys are already server-generated UUIDs, never client paths).
 */
export class FsFileStore implements FileStore {
  private readonly baseDir: string;
  private readonly prefix: string;

  constructor(opts: FsFileStoreOptions) {
    this.baseDir = resolve(opts.baseDir);
    this.prefix = opts.keyPrefix ?? '';
  }

  /** Absolute data path for a key, guaranteed to stay within `baseDir`. */
  private pathFor(key: string): string {
    const full = resolve(this.baseDir, this.prefix + key);
    if (full !== this.baseDir && !full.startsWith(this.baseDir + sep)) {
      throw new Error(`Refusing a key that escapes the base directory: ${key}`);
    }
    return full;
  }

  async put(
    key: string,
    body: Readable | Buffer,
    opts: PutOptions = {},
  ): Promise<StoredFile> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), {recursive: true});
    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    await pipeline(source, createWriteStream(p));
    const sidecar: Sidecar = {
      ...(opts.contentType ? {contentType: opts.contentType} : {}),
      ...(opts.filename ? {filename: opts.filename} : {}),
      ...(opts.metadata ? {metadata: opts.metadata} : {}),
    };
    await writeFile(`${p}.meta.json`, JSON.stringify(sidecar));
    const {size} = await fsStat(p);
    return {key, size, contentType: opts.contentType};
  }

  async get(key: string): Promise<RetrievedFile> {
    const p = this.pathFor(key);
    let size: number;
    try {
      ({size} = await fsStat(p));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(key);
      }
      throw err;
    }
    const sidecar = await this.readSidecar(p);
    return {
      key,
      stream: createReadStream(p),
      size,
      contentType: sidecar.contentType,
      filename: sidecar.filename,
      metadata: sidecar.metadata,
    };
  }

  async stat(key: string): Promise<FileMetadata> {
    const p = this.pathFor(key);
    let st: Awaited<ReturnType<typeof fsStat>>;
    try {
      st = await fsStat(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(key);
      }
      throw err;
    }
    const sidecar = await this.readSidecar(p);
    return {
      key,
      size: st.size,
      contentType: sidecar.contentType,
      filename: sidecar.filename,
      metadata: sidecar.metadata,
      lastModified: st.mtime,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.pathFor(key);
    await rm(p, {force: true});
    await rm(`${p}.meta.json`, {force: true});
  }

  private async readSidecar(p: string): Promise<Sidecar> {
    try {
      return JSON.parse(await readFile(`${p}.meta.json`, 'utf8')) as Sidecar;
    } catch {
      return {};
    }
  }
}
