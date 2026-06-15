// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Readable} from 'node:stream';
import type {RetrievedFile} from '@agentback/files';

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
