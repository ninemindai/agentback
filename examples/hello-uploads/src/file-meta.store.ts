// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import {BindingKey} from '@agentback/core';

/** A stored file's metadata row. */
export interface FileRow {
  id: string;
  key: string;
  owner: string;
  filename: string;
  mimeType: string;
  size: number;
  label: string | null;
}

/**
 * In-memory file-metadata table. In production this is a Drizzle `files`
 * table (id, key, owner, filename, mime, size, sha256, created_at) — see
 * `@agentback/drizzle` and the README. The interface is the same: create,
 * look up by id, list by owner.
 */
export class FileMetaStore {
  private readonly rows = new Map<string, FileRow>();

  create(input: Omit<FileRow, 'id'>): FileRow {
    const row: FileRow = {id: randomUUID(), ...input};
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): FileRow | undefined {
    return this.rows.get(id);
  }

  byOwner(owner: string): FileRow[] {
    return [...this.rows.values()].filter(r => r.owner === owner);
  }
}

export const FILE_META = BindingKey.create<FileMetaStore>('files.meta');
