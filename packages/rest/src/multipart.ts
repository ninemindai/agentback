// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
// `multer` is the Express-path multipart parser; `multer/storage/disk` pulls
// `node:fs`, which is edge-hostile. Import it as a TYPE only and load the
// runtime lazily via createRequire inside `makeMultipartMiddleware` (the
// Express/Node mount path), so a fetch-only worker never drags it onto the
// static bundle graph. Mirrors the edge-safe dotenv loader in @agentback/common.
import type multer from 'multer';
import type {Request, RequestHandler} from 'express';
import createError from 'http-errors';
import type {Context} from '@agentback/context';
import {FILE_STORE, type FileStore} from '@agentback/files';
import type {FileFieldEntry, UploadedFile} from '@agentback/openapi';

/**
 * Resolve the `multer` runtime lazily, off the static import graph. Uses
 * `process.getBuiltinModule('node:module')` + `createRequire` so the
 * `require('multer')` literal never appears in an esbuild `platform:'browser'`
 * bundle — only called on the Express host when a `fileField` route mounts.
 */
function loadMulter(): typeof import('multer') {
  const _process = process as NodeJS.Process & {
    getBuiltinModule?<T = unknown>(id: string): T;
  };
  const nodeModule = _process.getBuiltinModule!(
    'node:module',
  ) as typeof import('node:module');
  const require = nodeModule.createRequire(import.meta.url);
  try {
    return require('multer') as typeof import('multer');
  } catch {
    // multer is an OPTIONAL peer dependency (uploads on the Express host only).
    // Fail with guidance instead of a raw ERR_MODULE_NOT_FOUND.
    throw new Error(
      "@agentback/rest: file uploads require the optional peer dependency " +
        "'multer'. Install it (`npm i multer`) to use fileField() routes on " +
        "the Express host, or serve via `listener: 'native'`, where multipart " +
        'is parsed with Web FormData (no multer needed).',
    );
  }
}

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
/**
 * Default upload cap (25 MiB) applied to any `fileField()` that omits
 * `maxSize`, so uploads are **never unbounded** (a DoS guard). Fields that set
 * `maxSize` keep their own limit; raise this per field for large assets.
 */
export const DEFAULT_MAX_FILE_SIZE = 25 * 1024 * 1024;

/**
 * The single global `fileSize` multer enforces pre-stream: the largest
 * per-field effective limit (`maxSize ?? DEFAULT`). multer can't do per-field
 * size, so a field with a smaller declared `maxSize` than a sibling is capped
 * coarsely here and exactly by its Zod `fileField` refine post-parse.
 */
export function multerFileSizeLimit(fileFields: FileFieldEntry[]): number {
  return Math.max(
    ...fileFields.map(f => f.options.maxSize ?? DEFAULT_MAX_FILE_SIZE),
  );
}

export function makeMultipartMiddleware(
  fileFields: FileFieldEntry[],
  context: Context,
): RequestHandler {
  const allowedByField = new Map(
    fileFields.map(f => [f.name, f.options.mimeTypes]),
  );

  const upload = loadMulter()({
    storage: fileStoreStorage(() =>
      context.get<FileStore>(FILE_STORE, {optional: true}),
    ),
    limits: {fileSize: multerFileSizeLimit(fileFields)},
    // Reject a disallowed MIME type BEFORE streaming a byte to the store —
    // so a bad upload never lands as an orphaned object. The Zod fileField
    // refine re-checks post-parse as defense in depth.
    fileFilter(_req, file, cb) {
      const allowed = allowedByField.get(file.fieldname);
      if (allowed && allowed.length && !allowed.includes(file.mimetype)) {
        cb(
          Object.assign(
            new Error(
              `Unsupported content type '${file.mimetype}' for field ` +
                `'${file.fieldname}'.`,
            ),
            {code: 'UNSUPPORTED_MEDIA_TYPE'},
          ),
        );
        return;
      }
      cb(null, true);
    },
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

/** Map a multer error to HTTP: oversize → 413, bad type → 415, else → 400. */
function toHttpError(err: unknown): Error {
  const e = err as {code?: string; message?: string};
  if (e?.code === 'LIMIT_FILE_SIZE') {
    const h = createError(413, 'Uploaded file exceeds the maximum allowed size.');
    (h as {code?: string}).code = 'payload_too_large';
    return h;
  }
  if (e?.code === 'UNSUPPORTED_MEDIA_TYPE') {
    const h = createError(415, e.message || 'Unsupported media type.');
    (h as {code?: string}).code = 'unsupported_media_type';
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
