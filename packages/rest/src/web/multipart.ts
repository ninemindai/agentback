// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import createError from 'http-errors';
import type {FileStore} from '@agentback/files';
import type {FileFieldEntry, UploadedFile} from '@agentback/openapi';
import {DEFAULT_MAX_FILE_SIZE} from '../multipart.js';

/**
 * The runtime-neutral, Web-standard counterpart of the Express `multipart.ts`
 * multer engine. Where the Express path uses multer + Node streams, this parses
 * a `multipart/form-data` body with `Request.formData()` (Node 22 / undici) and
 * streams each declared `fileField()`'s `File`/`Blob` to the bound
 * {@link FileStore} under a **server-generated UUID** key — the SAME key scheme
 * and `FileStore.put` contract the multer engine uses, producing
 * {@link UploadedFile} handles identical in shape. Non-file form fields are
 * merged alongside the handles so the route's Zod body schema validates the
 * whole bundle exactly as it does on Express.
 *
 * Error → HTTP mapping mirrors `multipart.ts`'s `toHttpError`: oversize → 413,
 * disallowed MIME → 415, malformed multipart → 400, with matching `code`s so the
 * error envelopes are byte-for-byte equal across both surfaces.
 */

/**
 * Per-field size cap: a declared `maxSize`, else the shared
 * {@link DEFAULT_MAX_FILE_SIZE} (so a Web upload is never unbounded, the same
 * DoS guard the Express path applies via `multerFileSizeLimit`). Unlike multer's
 * single coarse global cap, the Web path enforces each field's OWN limit
 * mid-stream — strictly tighter, and the Zod `fileField` refine re-checks
 * post-parse as defense in depth on both surfaces.
 */
function maxSizeOf(entry: FileFieldEntry): number {
  return entry.options.maxSize ?? DEFAULT_MAX_FILE_SIZE;
}

/** Oversize → 413 (`payload_too_large`), mirroring `multipart.ts`. */
function tooLarge(): Error {
  const h = createError(413, 'Uploaded file exceeds the maximum allowed size.');
  (h as {code?: string}).code = 'payload_too_large';
  return h;
}

/** Disallowed MIME → 415 (`unsupported_media_type`), mirroring `multipart.ts`. */
function unsupportedMediaType(mimeType: string, field: string): Error {
  const h = createError(
    415,
    `Unsupported content type '${mimeType}' for field '${field}'.`,
  );
  (h as {code?: string}).code = 'unsupported_media_type';
  return h;
}

/** Malformed multipart → 400 (`invalid_multipart`), mirroring `multipart.ts`. */
function invalidMultipart(message?: string): Error {
  const h = createError(400, message || 'Invalid multipart request.');
  (h as {code?: string}).code = 'invalid_multipart';
  return h;
}

/**
 * A Node {@link Readable} over a Web `ReadableStream` that counts bytes and
 * destroys itself with an error the moment the running total exceeds `maxSize`.
 * Used as the streaming source handed to `FileStore.put`, so an oversize upload
 * aborts mid-stream (the partial object is then deleted) rather than being
 * buffered whole — no need to hold the full file in memory to enforce the cap.
 */
function countingReadable(
  webStream: ReadableStream<Uint8Array>,
  maxSize: number,
): {readable: Readable; size: () => number; oversize: () => boolean} {
  let total = 0;
  let oversize = false;
  const reader = webStream.getReader();
  const readable = new Readable({
    async read() {
      try {
        const {done, value} = await reader.read();
        if (done) {
          this.push(null);
          return;
        }
        total += value.byteLength;
        if (total > maxSize) {
          oversize = true;
          // Abort the underlying source and surface a typed error so `put`
          // rejects; the caller maps it to 413 and deletes the partial.
          await reader.cancel().catch(() => {});
          this.destroy(tooLarge());
          return;
        }
        this.push(Buffer.from(value));
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });
  return {readable, size: () => total, oversize: () => oversize};
}

/** Is `code` the typed 413 we raised mid-stream? */
function isOversizeError(err: unknown): boolean {
  return (err as {code?: string})?.code === 'payload_too_large';
}

async function storeFile(
  entry: FileFieldEntry,
  file: File,
  store: FileStore,
): Promise<UploadedFile> {
  const maxSize = maxSizeOf(entry);
  const key = randomUUID();
  const {readable} = countingReadable(
    file.stream() as ReadableStream<Uint8Array>,
    maxSize,
  );
  try {
    const stored = await store.put(key, readable, {
      contentType: file.type || 'application/octet-stream',
      filename: file.name,
    });
    return {
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: stored.size,
      fieldname: entry.name,
      key,
    };
  } catch (err) {
    // Best-effort cleanup of the orphaned partial, then re-raise so the
    // dispatcher's try/catch maps it to the right status (413 for oversize).
    await store.delete(key).catch(() => {});
    throw err;
  }
}

/**
 * Buffer a `File` in memory (the no-`FileStore`-bound fallback, matching the
 * multer engine's memory branch), enforcing `maxSize` as bytes accumulate.
 */
async function bufferFile(
  entry: FileFieldEntry,
  file: File,
): Promise<UploadedFile> {
  const maxSize = maxSizeOf(entry);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxSize) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks);
  return {
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: buffer.byteLength,
    fieldname: entry.name,
    buffer,
  };
}

/**
 * Parse a `multipart/form-data` Web {@link Request} for the given
 * `fileField()`s. For each declared field, the first `File` entry is streamed to
 * the bound {@link FileStore} (or buffered when none is bound) under a
 * server-generated UUID; the resulting {@link UploadedFile} handle is merged
 * with the non-file form fields into a single body object for Zod validation —
 * the Web mirror of `multipart.ts`'s `mergeFilesIntoBody`.
 *
 * @param request the multipart Web Request (its body is consumed here)
 * @param fileFields the route's declared file fields (from `fileFieldsOf`)
 * @param store the bound FileStore, or `undefined` to buffer in memory
 */
export async function parseWebMultipart(
  request: Request,
  fileFields: FileFieldEntry[],
  store: FileStore | undefined,
): Promise<Record<string, unknown>> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    throw invalidMultipart((err as Error)?.message);
  }

  const fileFieldNames = new Set(fileFields.map(f => f.name));
  const body: Record<string, unknown> = {};

  // Non-file form fields: carry string values through so the body schema
  // validates them (parity with multer, which leaves text fields on req.body).
  // Repeated keys collapse to an array, matching the query-section convention.
  for (const [name, value] of form.entries()) {
    if (fileFieldNames.has(name)) continue;
    if (typeof value !== 'string') continue;
    if (name in body) {
      const prev = body[name];
      body[name] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    } else {
      body[name] = value;
    }
  }

  // File fields: validate MIME up front (415 before a byte is stored, matching
  // multer's fileFilter), then stream/buffer to the store. A missing required
  // file is simply absent here — the Zod body refine then fails it as a 400,
  // exactly as on the Express path.
  for (const entry of fileFields) {
    const value = form.get(entry.name);
    if (value == null || typeof value === 'string') continue;
    const file = value as File;

    const allowed = entry.options.mimeTypes;
    const mimeType = file.type || 'application/octet-stream';
    if (allowed && allowed.length && !allowed.includes(mimeType)) {
      throw unsupportedMediaType(mimeType, entry.name);
    }

    try {
      body[entry.name] = store
        ? await storeFile(entry, file, store)
        : await bufferFile(entry, file);
    } catch (err) {
      if (isOversizeError(err)) throw err;
      throw invalidMultipart((err as Error)?.message);
    }
  }

  return body;
}
