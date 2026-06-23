// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Readable} from 'node:stream';
import type {ByteRange, FileStore, RetrievedFile} from '@agentback/files';

const FILE_RESPONSE = Symbol.for('agentback.fileResponse');

/** How a {@link fileResponse} is rendered to the wire. */
export interface FileResponseInit {
  contentType?: string;
  /** Sets `Content-Disposition`; omit for none. */
  filename?: string;
  /** `attachment` (download) or `inline` (render). Default `attachment`. */
  disposition?: 'attachment' | 'inline';
  /** Sets `Content-Length` when known. */
  size?: number;
  /** HTTP status to send; defaults to the route's success status (200). */
  status?: number;
  /** Extra response headers (e.g. `Content-Range`, `Accept-Ranges`). */
  headers?: Record<string, string>;
}

/** A binary handler result: `RestServer.sendResult` pipes it instead of JSON. */
export interface FileResponse extends FileResponseInit {
  readonly [FILE_RESPONSE]: true;
  body: Readable | Buffer;
}

/**
 * Return value for a route that sends a file (download). `RestServer` detects
 * it and streams `body` to the response with the right `Content-Type` /
 * `Content-Disposition` instead of JSON-encoding. Declare the route with no
 * `response:` schema (binary isn't JSON).
 *
 * @example
 *   @get('/files/{id}', {path: FileId})
 *   async download(input: {path: {id: string}}) {
 *     const f = await this.store.get(keyFor(input.path.id));
 *     return fileResponse(f.stream, {contentType: f.contentType, filename: f.filename});
 *   }
 */
export function fileResponse(
  body: Readable | Buffer,
  init: FileResponseInit = {},
): FileResponse {
  return {[FILE_RESPONSE]: true, body, ...init};
}

/** Convenience: turn a {@link RetrievedFile} (from a FileStore) into a download. */
export function fileDownload(
  file: RetrievedFile,
  init: Pick<FileResponseInit, 'disposition'> = {},
): FileResponse {
  return fileResponse(file.stream, {
    contentType: file.contentType,
    filename: file.filename,
    size: file.size,
    disposition: init.disposition ?? 'attachment',
  });
}

export function isFileResponse(v: unknown): v is FileResponse {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as Record<symbol, unknown>)[FILE_RESPONSE] === true
  );
}

/**
 * Parse an HTTP `Range` request-header value against a known object `size`.
 *
 * Returns the resolved {@link ByteRange} (0-based, `end` inclusive, clamped to
 * the object) for a single satisfiable `bytes=` range; `'unsatisfiable'` when
 * the range starts at/after EOF (the caller should reply `416`); or `null` when
 * there is no range, the header is malformed, or it asks for multiple ranges
 * (the caller should serve the whole object). Supports `bytes=start-end`,
 * `bytes=start-` (to EOF), and `bytes=-suffix` (final N bytes).
 *
 * `If-Range` is **not** evaluated here — a conditional range is honored
 * unconditionally; add validator handling at the call site if you need it.
 */
export function parseRangeHeader(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(.+)$/.exec(header.trim());
  if (!m) return null;
  // Multiple ranges (comma-separated) aren't supported — serve the whole object.
  if (m[1].includes(',')) return null;
  const dash = m[1].indexOf('-');
  if (dash < 0) return null;
  const startStr = m[1].slice(0, dash).trim();
  const endStr = m[1].slice(dash + 1).trim();
  if (size <= 0) return 'unsatisfiable';

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix form: bytes=-N → the final N bytes.
    const suffix = Number(endStr);
    if (endStr === '' || !Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startStr);
    if (!Number.isInteger(start) || start < 0) return null;
    if (start >= size) return 'unsatisfiable';
    if (endStr === '') {
      end = size - 1;
    } else {
      end = Number(endStr);
      if (!Number.isInteger(end) || end < start) return null;
      end = Math.min(end, size - 1);
    }
  }
  return {start, end};
}

/** Inputs to {@link serveFile}: overrides plus the incoming `Range` header. */
export interface ServeFileInit {
  /** Override the stored content type. */
  contentType?: string;
  /** Override the stored filename for `Content-Disposition`. */
  filename?: string;
  /** `attachment` (download) or `inline` (render). Default `attachment`. */
  disposition?: 'attachment' | 'inline';
  /** Raw incoming `Range` header value (e.g. from a validated `headers` slot). */
  range?: string;
}

/**
 * Serve a stored object as a download with full HTTP `Range` support — the
 * one-call recipe behind video seeking and resumable downloads. Reads metadata
 * via `store.stat`, interprets the `Range` header, and returns a
 * {@link FileResponse} that the REST send path renders:
 *
 * - no/whole-object request → `200` with `Accept-Ranges: bytes`;
 * - a satisfiable range → `206` with `Content-Range` and only the slice
 *   (fetched via `store.get(key, {range})`, so the bytes are never over-read);
 * - an unsatisfiable range → `416` with `Content-Range: bytes *​/<size>`.
 *
 * A missing key throws `FileNotFoundError` (mapped to `404` upstream).
 *
 * @example
 *   @get('/media/{id}', {path: IdParam, headers: z.object({range: z.string().optional()})})
 *   async stream(input: {path: {id: string}; headers: {range?: string}}) {
 *     return serveFile(this.store, keyFor(input.path.id), {
 *       range: input.headers.range, disposition: 'inline',
 *     });
 *   }
 */
export async function serveFile(
  store: Pick<FileStore, 'stat' | 'get'>,
  key: string,
  init: ServeFileInit = {},
): Promise<FileResponse> {
  const {disposition} = init;
  // Fast path: no Range → one round-trip, full body, advertise range support.
  if (!init.range) {
    const file = await store.get(key);
    return fileResponse(file.stream, {
      contentType: init.contentType ?? file.contentType,
      filename: init.filename ?? file.filename,
      size: file.size,
      disposition,
      headers: {'Accept-Ranges': 'bytes'},
    });
  }

  // A range needs the total size up front (for parsing + the Content-Range tail).
  const meta = await store.stat(key);
  const total = meta.size;
  const parsed = parseRangeHeader(init.range, total);

  if (parsed === 'unsatisfiable') {
    return fileResponse(Buffer.alloc(0), {
      status: 416,
      headers: {'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${total}`},
    });
  }
  if (!parsed) {
    const file = await store.get(key);
    return fileResponse(file.stream, {
      contentType: init.contentType ?? meta.contentType,
      filename: init.filename ?? meta.filename,
      size: file.size,
      disposition,
      headers: {'Accept-Ranges': 'bytes'},
    });
  }

  const file = await store.get(key, {range: parsed});
  const end = parsed.end ?? total - 1;
  return fileResponse(file.stream, {
    contentType: init.contentType ?? meta.contentType,
    filename: init.filename ?? meta.filename,
    size: file.size,
    disposition,
    status: 206,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${parsed.start}-${end}/${total}`,
    },
  });
}
