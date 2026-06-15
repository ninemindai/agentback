// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import multer from 'multer';
import type {Request, RequestHandler} from 'express';
import createError from 'http-errors';
import type {Context} from '@agentback/context';
import {FILE_STORE, type FileStore} from '@agentback/files';
import type {FileFieldEntry, UploadedFile} from '@agentback/openapi';

/**
 * A multer `StorageEngine` that streams each uploaded file straight to the
 * bound {@link FileStore} under a **server-generated UUID** key (never a
 * client-supplied path — that's the S3 key-traversal hole dapp5 left open).
 * When no `FileStore` is bound it buffers in memory, so uploads still work in
 * dev/tests; production binds a streaming store.
 */
function fileStoreStorage(
  getStore: () => Promise<FileStore | undefined>,
): multer.StorageEngine {
  return {
    async _handleFile(_req, file, cb) {
      try {
        const store = await getStore();
        if (store) {
          const key = randomUUID();
          const stored = await store.put(key, file.stream, {
            contentType: file.mimetype,
            filename: file.originalname,
          });
          cb(null, {key, size: stored.size} as Partial<Express.Multer.File>);
        } else {
          const chunks: Buffer[] = [];
          for await (const c of file.stream) {
            chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
          }
          const buffer = Buffer.concat(chunks);
          cb(null, {buffer, size: buffer.byteLength});
        }
      } catch (err) {
        cb(err as Error);
      }
    },
    async _removeFile(_req, file, cb) {
      const key = (file as {key?: string}).key;
      const store = await getStore();
      if (store && key) {
        try {
          await store.delete(key);
        } catch {
          // best-effort cleanup of an orphaned partial upload
        }
      }
      cb(null);
    },
  };
}

/**
 * Build an Express middleware that parses a `multipart/form-data` body for the
 * given `fileField()`s, streams each file to the {@link FileStore}, and merges
 * the resulting {@link UploadedFile} handles back into `req.body` so the
 * route's Zod body schema validates them. Mounted automatically by
 * `RestServer` for any route whose `body:` schema declares a file field.
 */
export function makeMultipartMiddleware(
  fileFields: FileFieldEntry[],
  context: Context,
): RequestHandler {
  const maxSize = fileFields.reduce<number | undefined>((m, f) => {
    const s = f.options.maxSize;
    if (s == null) return m;
    return m == null ? s : Math.max(m, s);
  }, undefined);

  const upload = multer({
    storage: fileStoreStorage(() =>
      context.get<FileStore>(FILE_STORE, {optional: true}),
    ),
    ...(maxSize != null ? {limits: {fileSize: maxSize}} : {}),
  });
  const run = upload.fields(fileFields.map(f => ({name: f.name, maxCount: 1})));

  return (req, res, next) => {
    run(req, res, (err: unknown) => {
      if (err) return next(toHttpError(err));
      mergeFilesIntoBody(req, fileFields);
      next();
    });
  };
}

/** Map a multer error to an HTTP error: oversize → 413, otherwise → 400. */
function toHttpError(err: unknown): Error {
  const e = err as {code?: string; message?: string};
  if (e?.code === 'LIMIT_FILE_SIZE') {
    const h = createError(413, 'Uploaded file exceeds the maximum allowed size.');
    (h as {code?: string}).code = 'payload_too_large';
    return h;
  }
  const h = createError(400, e?.message || 'Invalid multipart request.');
  (h as {code?: string}).code = 'invalid_multipart';
  return h;
}

/** Move each parsed file from `req.files` onto `req.body` as an UploadedFile. */
function mergeFilesIntoBody(req: Request, fileFields: FileFieldEntry[]): void {
  if (!req.body || typeof req.body !== 'object') req.body = {};
  const files = req.files as
    | Record<string, Express.Multer.File[]>
    | undefined;
  if (!files) return;
  const body = req.body as Record<string, unknown>;
  for (const {name} of fileFields) {
    const file = files[name]?.[0];
    if (file) body[name] = toUploadedFile(file);
  }
}

function toUploadedFile(
  f: Express.Multer.File & {key?: string},
): UploadedFile {
  return {
    filename: f.originalname,
    mimeType: f.mimetype,
    size: f.size,
    fieldname: f.fieldname,
    ...(f.buffer ? {buffer: f.buffer} : {}),
    ...(f.key ? {key: f.key} : {}),
  };
}
