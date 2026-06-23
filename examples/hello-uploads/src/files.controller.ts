// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, get, post, fileField, AgentError} from '@agentback/openapi';
import {FILE_STORE, type FileStore} from '@agentback/files';
import {serveFile} from '@agentback/rest';
import {FileMetaStore, FILE_META} from './file-meta.store.js';

// Caller identity. A real app injects an authenticated principal
// (@authenticate + SecurityBindings.USER); a header keeps the example short.
const Caller = z.object({'x-user-id': z.string().min(1)});

// The download adds an optional Range header — `serveFile` turns it into a
// 206/Content-Range slice (video seek, resumable downloads). Validated header
// slots keep it host-neutral (works on RestApplication and EdgeRestApplication).
const DownloadHeaders = Caller.extend({range: z.string().optional()});

// One declaration → multipart parser + runtime validation + OpenAPI
// (multipart/form-data, `file` as format:binary).
const UploadBody = z.object({
  file: fileField({maxSize: 5_000_000, description: 'the file to store'}),
  label: z.string().max(120).optional(),
});

const IdParam = z.object({id: z.string()});
const FileInfo = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  size: z.number().int(),
  label: z.string().nullable(),
});

/**
 * Upload / list / download, scoped per caller.
 *
 * Security (the two FIXMEs dapp5 left open, fixed here):
 *  - Storage keys are server-generated UUIDs (from the multipart parser),
 *    never the client filename — so a download id can't traverse into the
 *    bucket.
 *  - Every read checks ownership against the caller.
 */
@api({basePath: '/files', tags: ['files']})
export class FilesController {
  constructor(
    @inject(FILE_STORE) private store: FileStore,
    @inject(FILE_META) private meta: FileMetaStore,
  ) {}

  @post('/', {
    body: UploadBody,
    headers: Caller,
    response: FileInfo,
    status: 201,
  })
  async upload(input: {
    body: z.infer<typeof UploadBody>;
    headers: z.infer<typeof Caller>;
  }): Promise<z.infer<typeof FileInfo>> {
    const f = input.body.file;
    const row = this.meta.create({
      key: f.key!, // server UUID from the streaming parser
      owner: input.headers['x-user-id'],
      filename: f.filename,
      mimeType: f.mimeType,
      size: f.size,
      label: input.body.label ?? null,
    });
    return toInfo(row);
  }

  @get('/', {headers: Caller, response: z.array(FileInfo)})
  async list(input: {
    headers: z.infer<typeof Caller>;
  }): Promise<z.infer<typeof FileInfo>[]> {
    return this.meta.byOwner(input.headers['x-user-id']).map(toInfo);
  }

  @get('/{id}', {path: IdParam, headers: DownloadHeaders})
  async download(input: {
    path: z.infer<typeof IdParam>;
    headers: z.infer<typeof DownloadHeaders>;
  }) {
    const row = this.meta.get(input.path.id);
    if (!row)
      throw new AgentError('No such file.', {status: 404, code: 'not_found'});
    if (row.owner !== input.headers['x-user-id']) {
      throw new AgentError('You do not own this file.', {
        status: 403,
        code: 'forbidden',
      });
    }
    // Ownership is enforced above; serveFile then handles Range → 206/416,
    // Accept-Ranges, and Content-Length. Omit `range` and it's a plain 200.
    return serveFile(this.store, row.key, {
      range: input.headers.range,
      filename: row.filename,
      disposition: 'inline',
    });
  }
}

function toInfo(row: {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  label: string | null;
}): z.infer<typeof FileInfo> {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    label: row.label,
  };
}

export {UploadBody, FileInfo};
