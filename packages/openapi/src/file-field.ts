// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z, type ZodType} from 'zod';

/**
 * The validated shape a `fileField()` slot carries into a handler. The
 * multipart parser produces it; `filename`/`mimeType`/`size` are always
 * present. Exactly one of `buffer` (memory storage) or `key` (streamed
 * straight to a `FileStore`) is set depending on the upload strategy.
 */
export interface UploadedFile {
  filename: string;
  mimeType: string;
  size: number;
  /** Multipart field name. */
  fieldname?: string;
  /** Bytes, when buffered in memory. */
  buffer?: Buffer;
  /** Storage key, when streamed to a FileStore. */
  key?: string;
}

/** Constraints for a {@link fileField}. */
export interface FileFieldOptions {
  /** Max size in bytes; larger uploads fail validation (mapped to 413 by REST). */
  maxSize?: number;
  /** Allowed MIME types; others fail validation. */
  mimeTypes?: string[];
  /** OpenAPI property description. */
  description?: string;
}

/** Runtime guard: is this value an {@link UploadedFile}? */
export function isUploadedFile(v: unknown): v is UploadedFile {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as UploadedFile).filename === 'string' &&
    typeof (v as UploadedFile).mimeType === 'string' &&
    typeof (v as UploadedFile).size === 'number'
  );
}

/**
 * A Zod schema for one uploaded file in a `multipart/form-data` body. Use it as
 * a property of the route's `body:` object — the presence of a `fileField`
 * flips the emitted OpenAPI request body to `multipart/form-data` and renders
 * the property as `{type: string, format: binary}` (via Zod v4 `.meta`, which
 * `z.toJSONSchema` carries through). One declaration drives the parser, runtime
 * validation, and the OpenAPI contract — no second source of truth.
 *
 * @example
 *   const Upload = z.object({
 *     file: fileField({maxSize: 5_000_000, mimeTypes: ['image/png', 'image/jpeg']}),
 *     caption: z.string().max(280).optional(),
 *   });
 *   @post('/photos', {body: Upload, response: Photo})
 *   async create(input: {body: z.infer<typeof Upload>}) { … input.body.file.size … }
 */
/**
 * Runtime config side-table keyed by the exact schema instance `fileField`
 * returns. Lets the multipart parser discover a body's file fields and their
 * limits (`maxSize`, `mimeTypes`) without those non-standard constraints
 * leaking into the emitted OpenAPI schema (the schema carries only the
 * standard `format: binary`).
 */
const FILE_FIELD_REGISTRY = new WeakMap<object, FileFieldOptions>();

export function fileField(opts: FileFieldOptions = {}): ZodType<UploadedFile> {
  let schema: ZodType<UploadedFile> = z.custom<UploadedFile>(isUploadedFile, {
    message: 'Expected an uploaded file',
  });
  if (opts.maxSize != null) {
    const max = opts.maxSize;
    schema = schema.refine(f => f.size <= max, {
      message: `File exceeds the maximum size of ${max} bytes`,
    });
  }
  if (opts.mimeTypes?.length) {
    const allowed = opts.mimeTypes;
    schema = schema.refine(f => allowed.includes(f.mimeType), {
      message: `Unsupported content type (allowed: ${allowed.join(', ')})`,
    });
  }
  const out = schema.meta({
    type: 'string',
    format: 'binary',
    ...(opts.description ? {description: opts.description} : {}),
  }) as ZodType<UploadedFile>;
  FILE_FIELD_REGISTRY.set(out, opts);
  return out;
}

/** A file field discovered on a body schema. */
export interface FileFieldEntry {
  name: string;
  options: FileFieldOptions;
}

/**
 * Discover the `fileField()` properties of a request-body schema (a `z.object`
 * root). Returns each field's form name and its limits so the multipart parser
 * can configure itself from the same declaration that drives validation +
 * OpenAPI. Non-object schemas (or objects with no file fields) return `[]`.
 * File fields must be declared directly on the object (not wrapped in
 * `.optional()`/`.default()`).
 */
export function fileFieldsOf(body: unknown): FileFieldEntry[] {
  const shape = (body as {shape?: Record<string, object>} | undefined)?.shape;
  if (!shape || typeof shape !== 'object') return [];
  const out: FileFieldEntry[] = [];
  for (const [name, prop] of Object.entries(shape)) {
    const options = FILE_FIELD_REGISTRY.get(prop);
    if (options) out.push({name, options});
  }
  return out;
}
